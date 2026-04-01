from __future__ import annotations

import json
import secrets
import uuid

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.schemas import NearbyVehicleOut, PublicIncidentCreate, PublicIncidentResponse
from app.services.trust_score import compute_trust_public_sos, count_nearby_reports

SPEED_KMH = 40.0


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
            SELECT ST_X(location::geometry), ST_Y(location::geometry)
            FROM incidents WHERE id = :id
            """
        ),
        {"id": str(incident_id)},
    ).one_or_none()
    if not row or row[0] is None:
        return None
    lng, lat = float(row[0]), float(row[1])
    rows = db.execute(
        text(
            """
            SELECT v.id,
              ST_X(v.location::geometry) AS lng,
              ST_Y(v.location::geometry) AS lat,
              ST_Distance(
                v.location,
                ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
                false
              ) AS dist_m
            FROM vehicles v
            WHERE v.vehicle_type = 'ambulance'
              AND v.is_available = true
              AND v.status = 'available'
            ORDER BY dist_m ASC
            LIMIT 1
            """
        ),
        {"lng": lng, "lat": lat},
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
) -> PublicIncidentResponse:
    has_gps = body.latitude is not None and body.longitude is not None
    n_reports = count_nearby_reports(db, corridor_id, body.latitude, body.longitude)
    tr = compute_trust_public_sos(
        has_gps=has_gps,
        has_photo=bool(body.photo_url),
        corroboration_count=n_reports,
        is_sms=False,
    )
    public_id = secrets.token_hex(4).upper()
    loc_sql = "NULL"
    params: dict = {
        "cid": str(corridor_id),
        "itype": body.incident_type,
        "sev": body.severity,
        "km": body.km_marker,
        "ts": tr.score,
        "tr": tr.recommendation,
        "rep": "public_sos",
        "inj": body.injured_count,
        "notes": body.notes,
        "photo": body.photo_url,
        "pid": public_id,
    }
    tf_json = json.dumps(tr.factors)
    if has_gps:
        loc_sql = "ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography"
        params["lng"] = body.longitude
        params["lat"] = body.latitude
    row = db.execute(
        text(
            f"""
            INSERT INTO incidents (
              corridor_id, incident_type, severity, km_marker, location,
              trust_score, trust_recommendation, trust_factors, status, reporter_type,
              injured_count, notes, photo_url, public_report_id
            ) VALUES (
              :cid, :itype, :sev, :km, {loc_sql},
              :ts, :tr, CAST(:tf AS jsonb), 'open', :rep,
              :inj, :notes, :photo, :pid
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
            "p": json.dumps({"source": "public_sos"}),
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


def list_nearby_ambulances(db: Session, incident_id: uuid.UUID, limit: int = 20) -> list[NearbyVehicleOut]:
    row = db.execute(
        text(
            """
            SELECT ST_X(location::geometry), ST_Y(location::geometry)
            FROM incidents WHERE id = :id
            """
        ),
        {"id": str(incident_id)},
    ).one_or_none()
    if not row or row[0] is None:
        return []
    lng, lat = float(row[0]), float(row[1])
    rows = db.execute(
        text(
            """
            SELECT v.id, v.label, v.status,
              ST_X(v.location::geometry) AS lng,
              ST_Y(v.location::geometry) AS lat,
              ST_Distance(
                v.location,
                ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
                false
              ) AS dist_m
            FROM vehicles v
            WHERE v.vehicle_type = 'ambulance'
              AND v.is_available = true
              AND v.status = 'available'
            ORDER BY dist_m ASC
            LIMIT :lim
            """
        ),
        {"lng": lng, "lat": lat, "lim": limit},
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
