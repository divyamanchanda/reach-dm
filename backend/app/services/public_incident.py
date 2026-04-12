from __future__ import annotations

import json
import secrets
import uuid

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.schemas import NearbyVehicleOut, PublicIncidentCreate, PublicIncidentResponse
from app.services.dispatch import NEARBY_VEHICLE_DRIVER_JOIN, NEARBY_VEHICLE_ORDER_BY
from app.services.trust_score import compute_trust_public_sos, count_nearby_reports

SPEED_KMH = 40.0


def _sos_details_json(body: PublicIncidentCreate) -> str | None:
    """Persist direction / hazards / vehicles_involved when any are non-default."""
    if not body.direction and not body.hazards and body.vehicles_involved == 1:
        return None
    payload: dict = {"vehicles_involved": body.vehicles_involved}
    if body.direction:
        payload["direction"] = body.direction
    if body.hazards:
        payload["hazards"] = body.hazards
    return json.dumps(payload)

# Great-circle distance in meters (Earth radius 6371 km); matches prior ST_Distance geography behavior closely enough.
_HAVERSINE_M = """
(
  6371000 * acos(
    least(1::double precision, greatest(-1::double precision,
      cos(radians(:ilat)) * cos(radians({tbl}.lat)) * cos(radians({tbl}.lng) - radians(:ilng))
      + sin(radians(:ilat)) * sin(radians({tbl}.lat))
    ))
  )
)
"""


def _eta_minutes(distance_m: float) -> float:
    if distance_m <= 0:
        return 0.0
    km = distance_m / 1000.0
    return round((km / SPEED_KMH) * 60.0, 1)


def _fetch_osrm_durations_and_distances(
    incident_lng: float,
    incident_lat: float,
    vehicles: list[dict],
) -> tuple[list[float | None], list[float | None]]:
    if not vehicles:
        return ([], [])
    # OSRM table API with one source (incident) and N destinations (vehicles).
    coords = [f"{incident_lng},{incident_lat}"] + [f"{v['lng']},{v['lat']}" for v in vehicles]
    coords_param = ";".join(coords)
    destinations = ";".join(str(i) for i in range(1, len(coords)))
    url = (
        f"{settings.routing_base_url.rstrip('/')}/table/v1/driving/{coords_param}"
        f"?sources=0&destinations={destinations}&annotations=duration,distance"
    )
    try:
        with httpx.Client(timeout=4.0) as client:
            response = client.get(url)
            response.raise_for_status()
        payload = response.json()
        durations = payload.get("durations", [])
        distances = payload.get("distances", [])
        if not durations or not distances or not durations[0] or not distances[0]:
            return ([None] * len(vehicles), [None] * len(vehicles))
        return (durations[0], distances[0])
    except Exception:
        return ([None] * len(vehicles), [None] * len(vehicles))


def nearest_available_ambulance_eta(db: Session, incident_id: uuid.UUID) -> float | None:
    row = db.execute(
        text(
            """
            SELECT lng, lat FROM incidents WHERE id = :id
            """
        ),
        {"id": str(incident_id)},
    ).one_or_none()
    if not row or row[0] is None or row[1] is None:
        return None
    lng, lat = float(row[0]), float(row[1])
    dist_sql = _HAVERSINE_M.format(tbl="v")
    rows = db.execute(
        text(
            f"""
            SELECT v.id,
              v.lng AS lng,
              v.lat AS lat,
              {dist_sql} AS dist_m
            FROM vehicles v
            {NEARBY_VEHICLE_DRIVER_JOIN}
            WHERE v.vehicle_type = 'ambulance'
              AND v.is_available = true
              AND v.status = 'available'
              AND v.lat IS NOT NULL AND v.lng IS NOT NULL
            {NEARBY_VEHICLE_ORDER_BY}
            LIMIT 1
            """
        ),
        {"ilng": lng, "ilat": lat},
    ).mappings().all()
    if not rows:
        return None
    vehicles = [{"lng": float(r["lng"]), "lat": float(r["lat"])} for r in rows]
    durations, _distances = _fetch_osrm_durations_and_distances(lng, lat, vehicles)
    duration_seconds = durations[0] if durations else None
    if duration_seconds is not None:
        return round(float(duration_seconds) / 60.0, 1)
    return _eta_minutes(float(rows[0]["dist_m"]))


def create_public_incident_row(
    db: Session,
    corridor_id: uuid.UUID,
    body: PublicIncidentCreate,
    *,
    reporter_type: str = "public_sos",
    incident_source: str | None = None,
    is_sms: bool = False,
    event_source: str = "public_sos",
) -> PublicIncidentResponse:
    has_gps = body.latitude is not None and body.longitude is not None
    n_reports = count_nearby_reports(db, corridor_id, body.latitude, body.longitude)
    tr = compute_trust_public_sos(
        has_gps=has_gps,
        has_photo=bool(body.photo_url),
        corroboration_count=n_reports,
        is_sms=is_sms,
    )
    public_id = secrets.token_hex(4).upper()
    sd = _sos_details_json(body)
    sos_sql = "CAST(:sd AS jsonb)" if sd is not None else "NULL"
    params: dict = {
        "cid": str(corridor_id),
        "itype": body.incident_type,
        "sev": body.severity,
        "km": body.km_marker,
        "ts": tr.score,
        "tr": tr.recommendation,
        "rep": reporter_type,
        "src": incident_source,
        "inj": body.injured_count,
        "notes": body.notes,
        "photo": body.photo_url,
        "pid": public_id,
    }
    if sd is not None:
        params["sd"] = sd
    tf_json = json.dumps(tr.factors)
    if has_gps:
        params["lat"] = body.latitude
        params["lng"] = body.longitude
        loc_sql = ":lat, :lng"
    else:
        loc_sql = "NULL, NULL"
    row = db.execute(
        text(
            f"""
            INSERT INTO incidents (
              corridor_id, incident_type, severity, km_marker, lat, lng,
              trust_score, trust_recommendation, trust_factors, status, reporter_type,
              injured_count, notes, photo_url, public_report_id, source, sos_details
            ) VALUES (
              :cid, :itype, :sev, :km, {loc_sql},
              :ts, :tr, CAST(:tf AS jsonb), 'open', :rep,
              :inj, :notes, :photo, :pid, :src, {sos_sql}
            )
            RETURNING id
            """
        ),
        {**params, "tf": tf_json},
    ).one()
    new_id = row[0]
    db.execute(
        text(
            """
            INSERT INTO incident_events (incident_id, event_type, payload)
            VALUES (:iid, 'created', CAST(:p AS jsonb))
            """
        ),
        {
            "iid": str(new_id),
            "p": json.dumps({"source": event_source}),
        },
    )
    db.commit()
    eta = nearest_available_ambulance_eta(db, new_id)
    return PublicIncidentResponse(
        incident_id=new_id,
        public_report_id=public_id,
        trust_score=tr.score,
        trust_recommendation=tr.recommendation,
        nearest_ambulance_eta_minutes=eta,
    )


def list_nearby_ambulances(
    db: Session,
    incident_id: uuid.UUID,
    limit: int = 20,
    exclude_vehicle_ids: set[uuid.UUID] | None = None,
) -> list[NearbyVehicleOut]:
    row = db.execute(
        text(
            """
            SELECT lng, lat FROM incidents WHERE id = :id
            """
        ),
        {"id": str(incident_id)},
    ).one_or_none()
    if not row or row[0] is None or row[1] is None:
        return []
    lng, lat = float(row[0]), float(row[1])
    dist_sql = _HAVERSINE_M.format(tbl="v")
    excl = exclude_vehicle_ids or set()
    excl_sql = ""
    params: dict = {"ilng": lng, "ilat": lat, "lim": limit}
    if excl:
        excl_sql = "AND v.id NOT IN (" + ", ".join(f":e{i}" for i in range(len(excl))) + ")"
        for i, uid in enumerate(excl):
            params[f"e{i}"] = str(uid)
    rows = db.execute(
        text(
            f"""
            SELECT v.id, v.label, v.status,
              v.lng AS lng,
              v.lat AS lat,
              {dist_sql} AS dist_m
            FROM vehicles v
            {NEARBY_VEHICLE_DRIVER_JOIN}
            WHERE v.vehicle_type = 'ambulance'
              AND v.is_available = true
              AND v.status = 'available'
              AND v.lat IS NOT NULL AND v.lng IS NOT NULL
              {excl_sql}
            {NEARBY_VEHICLE_ORDER_BY}
            LIMIT :lim
            """
        ),
        params,
    ).mappings().all()
    vehicles_for_routing = [{"lng": float(r["lng"]), "lat": float(r["lat"])} for r in rows]
    durations, routed_distances = _fetch_osrm_durations_and_distances(lng, lat, vehicles_for_routing)
    out: list[NearbyVehicleOut] = []
    for idx, r in enumerate(rows):
        used_route = durations[idx] is not None and routed_distances[idx] is not None
        d = float(routed_distances[idx]) if routed_distances[idx] is not None else float(r["dist_m"])
        eta = round(float(durations[idx]) / 60.0, 1) if durations[idx] is not None else _eta_minutes(d)
        out.append(
            NearbyVehicleOut(
                vehicle_id=r["id"],
                label=r["label"],
                status=r["status"],
                distance_meters=round(d, 1),
                eta_minutes=eta,
                eta_source="route" if used_route else "fallback",
            )
        )
    return out
