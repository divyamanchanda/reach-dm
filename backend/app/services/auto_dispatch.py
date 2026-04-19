from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Vehicle
from app.services.audit_log import log_audit
from app.services.dispatch import run_dispatch
from app.services.public_incident import list_nearby_ambulances

AUTO_DISPATCH_OPEN_MINUTES = 3


def _format_incident_type(raw: str) -> str:
    return raw.replace("_", " ").strip() or "incident"


def process_auto_dispatch_candidates(db: Session) -> list[tuple[uuid.UUID, str]]:
    """Dispatch the nearest available ambulance for stale open incidents. Returns notifications for operators."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=AUTO_DISPATCH_OPEN_MINUTES)
    rows = db.execute(
        text(
            """
            SELECT i.id AS incident_id, i.corridor_id, i.incident_type, i.km_marker
            FROM incidents i
            INNER JOIN corridors c ON c.id = i.corridor_id
            WHERE i.status = 'open'
              AND c.auto_dispatch_enabled IS TRUE
              AND i.created_at < :cutoff
              AND i.lat IS NOT NULL
              AND i.lng IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.incident_id = i.id)
            ORDER BY i.created_at ASC
            """
        ),
        {"cutoff": cutoff},
    ).mappings().all()

    notifications: list[tuple[uuid.UUID, str]] = []
    for row in rows:
        incident_id = row["incident_id"]
        corridor_id = row["corridor_id"]
        itype = _format_incident_type(str(row["incident_type"] or ""))
        km = row["km_marker"]
        nearby = list_nearby_ambulances(db, incident_id, limit=8)
        if not nearby:
            continue
        pick = nearby[0].vehicle_id
        veh = db.get(Vehicle, pick)
        if not veh:
            continue
        try:
            run_dispatch(db, incident_id=incident_id, vehicle_id=pick, auto=True)
        except HTTPException:
            continue
        km_s = f"{float(km):.0f}" if km is not None else "—"
        msg = f"⚡ Auto-dispatched {veh.label} to KM {km_s} {itype}"
        log_audit(
            action="auto_dispatched",
            entity_type="incident",
            entity_id=incident_id,
            details={
                "vehicle_id": str(pick),
                "vehicle_label": veh.label,
                "corridor_id": str(corridor_id),
                "message": msg,
            },
        )
        notifications.append((corridor_id, msg))
    return notifications
