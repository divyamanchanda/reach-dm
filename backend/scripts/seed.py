"""
Load dummy REACH data into PostgreSQL.
Run:  cd backend && python -m scripts.seed

Requires DB from docker-compose (or equivalent) and schema from infra/init-db.sql.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import SessionLocal


def _hash(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def clear_and_seed(db: Session) -> None:
    db.execute(text("TRUNCATE dispatches, incident_events, incidents, vehicles, zones, users, corridors, organisations RESTART IDENTITY CASCADE"))
    org_id = uuid.UUID("c0ffee00-0000-4000-8000-000000000001")
    corridor_id = uuid.UUID("c0ffee00-0000-4000-8000-000000000002")
    op_id = uuid.UUID("c0ffee00-0000-4000-8000-000000000010")
    driver_id = uuid.UUID("c0ffee00-0000-4000-8000-000000000011")
    pw = _hash("reach2026")

    db.execute(
        text(
            """
            INSERT INTO organisations (id, name) VALUES (:id, 'IRB Infrastructure (demo)')
            """
        ),
        {"id": str(org_id)},
    )
    db.execute(
        text(
            """
            INSERT INTO corridors (
              id, organisation_id, name, code,
              start_lat, start_lng, end_lat, end_lng, waypoints,
              km_start, km_end, is_active
            )
            VALUES (
              :id, :oid, 'NH48 Bengaluru–Chennai (demo)', 'NH48',
              :s_lat, :s_lng, :e_lat, :e_lng, CAST(:wps AS jsonb),
              0, 312, true
            )
            """
        ),
        {
            "id": str(corridor_id),
            "oid": str(org_id),
            "s_lat": 12.9716,
            "s_lng": 77.5946,
            "e_lat": 13.0827,
            "e_lng": 80.2707,
            "wps": json.dumps(
                [
                    {"lat": 12.9716, "lng": 77.5946},
                    {"lat": 12.8458, "lng": 77.6692},
                    {"lat": 12.7409, "lng": 77.8253},
                    {"lat": 12.5266, "lng": 78.2137},
                    {"lat": 12.7833, "lng": 78.7167},
                    {"lat": 12.9165, "lng": 79.1325},
                    {"lat": 12.9224, "lng": 79.3327},
                    {"lat": 12.9674, "lng": 79.9475},
                    {"lat": 13.0827, "lng": 80.2707},
                ]
            ),
        },
    )
    for zone_name, a, b in [
        ("Zone A", 0, 80),
        ("Zone B", 80, 160),
        ("Zone C", 160, 240),
        ("Zone D", 240, 312),
    ]:
        db.execute(
            text(
                """
                INSERT INTO zones (id, corridor_id, name, km_start, km_end)
                VALUES (gen_random_uuid(), :cid, :name, :a, :b)
                """
            ),
            {"cid": str(corridor_id), "name": zone_name, "a": a, "b": b},
        )

    db.execute(
        text(
            """
            INSERT INTO users (id, organisation_id, phone, password_hash, full_name, role)
            VALUES
              (:id, :oid, '+919876543210', :ph, 'Mohan Rao (Dispatch)', 'dispatch_operator'),
              (:did, :oid, '+919876543211', :ph, 'Suresh Kumar (Driver)', 'driver')
            """
        ),
        {"id": str(op_id), "did": str(driver_id), "oid": str(org_id), "ph": pw},
    )

    # Vehicles near Bangalore–Chennai corridor (illustrative coordinates)
    amb = [
        ("AMB-01", "on_scene", False, 77.6, 12.97),
        ("AMB-02", "available", True, 77.55, 13.05),
        ("AMB-03", "dispatched", False, 77.7, 12.85),
        ("AMB-04", "available", True, 78.0, 12.9),
        ("AMB-05", "available", True, 77.4, 13.1),
    ]
    vids = []
    for label, st, avail, lng, lat in amb:
        vid = uuid.uuid4()
        vids.append((vid, label, st, avail, lng, lat))
        db.execute(
            text(
                """
                INSERT INTO vehicles (id, corridor_id, label, vehicle_type, status, is_available, lat, lng)
                VALUES (:id, :cid, :label, 'ambulance', :st, :avail, :lat, :lng)
                """
            ),
            {
                "id": str(vid),
                "cid": str(corridor_id),
                "label": label,
                "st": st,
                "avail": avail,
                "lng": lng,
                "lat": lat,
            },
        )

    now = datetime.now(timezone.utc)
    incidents_spec = [
        {
            "type": "accident",
            "sev": "critical",
            "km": 142.0,
            "lng": 77.62,
            "lat": 12.96,
            "trust": 72,
            "rec": "dispatch_immediately",
            "status": "open",
            "rep": "public_sos",
        },
        {
            "type": "truck",
            "sev": "major",
            "km": 198.0,
            "lng": 77.72,
            "lat": 12.88,
            "trust": 68,
            "rec": "verify_then_dispatch",
            "status": "dispatched",
            "rep": "patrol_officer",
        },
        {
            "type": "breakdown",
            "sev": "minor",
            "km": 87.0,
            "lng": 77.5,
            "lat": 13.02,
            "trust": 44,
            "rec": "patrol_verify_first",
            "status": "verifying",
            "rep": "sms",
        },
        {
            "type": "pedestrian",
            "sev": "major",
            "km": 234.0,
            "lng": 77.58,
            "lat": 12.99,
            "trust": 75,
            "rec": "dispatch_immediately",
            "status": "dispatched",
            "rep": "patrol_officer",
        },
    ]
    iids = []
    for spec in incidents_spec:
        iid = uuid.uuid4()
        iids.append(iid)
        factors = json.dumps([{"factor": "seed", "weight": 0, "note": "Demo data"}])
        db.execute(
            text(
                """
                INSERT INTO incidents (
                  id, corridor_id, incident_type, severity, km_marker, lat, lng,
                  trust_score, trust_recommendation, trust_factors, status, reporter_type, injured_count, public_report_id
                ) VALUES (
                  :id, :cid, :itype, :sev, :km, :lat, :lng,
                  :ts, :tr, CAST(:tf AS jsonb), :st, :rep, :inj, :pid
                )
                """
            ),
            {
                "id": str(iid),
                "cid": str(corridor_id),
                "itype": spec["type"],
                "sev": spec["sev"],
                "km": spec["km"],
                "lng": spec["lng"],
                "lat": spec["lat"],
                "ts": spec["trust"],
                "tr": spec["rec"],
                "tf": factors,
                "st": spec["status"],
                "rep": spec["rep"],
                "inj": 1 if spec["sev"] != "minor" else 0,
                "pid": iid.hex[:8].upper(),
            },
        )
        db.execute(
            text(
                """
                INSERT INTO incident_events (incident_id, event_type, payload, created_at)
                VALUES (:iid, 'created', '{}'::jsonb, :ts)
                """
            ),
            {"iid": str(iid), "ts": now - timedelta(minutes=30)},
        )

    # Link second incident to third vehicle (AMB-03) as dispatched
    db.execute(
        text(
            """
            INSERT INTO dispatches (incident_id, vehicle_id, cross_boundary)
            VALUES (:iid, :vid, false)
            """
        ),
        {"iid": str(iids[1]), "vid": str(vids[2][0])},
    )
    db.execute(
        text(
            """
            INSERT INTO dispatches (incident_id, vehicle_id, cross_boundary)
            VALUES (:iid, :vid, false)
            """
        ),
        {"iid": str(iids[3]), "vid": str(vids[0][0])},
    )

    # App3 driver (+919876543211) is assigned to AMB-03, which has an open dispatched incident
    db.execute(
        text("UPDATE vehicles SET driver_user_id = :uid WHERE id = :vid"),
        {"uid": str(driver_id), "vid": str(vids[2][0])},
    )

    db.commit()
    print("Seed complete.")
    print("Corridor ID (use in App2 QR / env):", corridor_id)
    print("Dispatch login phone: +919876543210  password: reach2026")
    print("Driver login (App3) phone: +919876543211  password: reach2026")


def main() -> None:
    with SessionLocal() as db:
        clear_and_seed(db)


if __name__ == "__main__":
    main()
