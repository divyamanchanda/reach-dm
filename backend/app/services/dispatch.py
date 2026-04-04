from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Dispatch, Incident, IncidentEvent, Vehicle

# --- Vehicle ranking for nearby / ETA queries (see app.services.public_incident) ---
# Prefer ambulances with an assigned crew; among those, prefer users with role "driver"
# so demo vehicle AMB-03 (Suresh) ranks above unassigned ambulances even if slightly farther.
NEARBY_VEHICLE_DRIVER_JOIN = "LEFT JOIN users driver_user ON driver_user.id = v.driver_user_id"

NEARBY_VEHICLE_ORDER_BY = """
ORDER BY
  CASE
    WHEN v.driver_user_id IS NOT NULL AND driver_user.role = 'driver' THEN 0
    WHEN v.driver_user_id IS NOT NULL THEN 1
    ELSE 2
  END ASC,
  dist_m ASC
"""


def run_dispatch(db: Session, *, incident_id: uuid.UUID, vehicle_id: uuid.UUID) -> Dispatch:
    """Single transaction: lock rows, validate, write dispatch + timeline + vehicle/incident updates."""
    try:
        inc_row = db.execute(
            text("SELECT id, corridor_id, status FROM incidents WHERE id = :id FOR UPDATE"),
            {"id": str(incident_id)},
        ).mappings().one()
        veh_row = db.execute(
            text(
                "SELECT id, corridor_id, vehicle_type, is_available, status FROM vehicles WHERE id = :id FOR UPDATE"
            ),
            {"id": str(vehicle_id)},
        ).mappings().one()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident or vehicle not found")

    if inc_row["status"] in ("closed", "cancelled", "recalled", "expired"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Incident not dispatchable")
    if veh_row["vehicle_type"] != "ambulance":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Vehicle is not an ambulance")
    if not veh_row["is_available"] or veh_row["status"] not in ("available",):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Vehicle not available")

    cross_boundary = str(veh_row["corridor_id"]) != str(inc_row["corridor_id"])

    dispatch = Dispatch(
        incident_id=incident_id,
        vehicle_id=vehicle_id,
        cross_boundary=cross_boundary,
    )
    db.add(dispatch)

    db.execute(
        text("UPDATE incidents SET status = :st, updated_at = now() WHERE id = :id"),
        {"st": "dispatched", "id": str(incident_id)},
    )
    db.execute(
        text(
            "UPDATE vehicles SET status = :st, is_available = false, updated_at = now() WHERE id = :id"
        ),
        {"st": "dispatched", "id": str(vehicle_id)},
    )

    ev = IncidentEvent(
        incident_id=incident_id,
        event_type="dispatch",
        payload={"vehicle_id": str(vehicle_id), "cross_boundary": cross_boundary},
    )
    db.add(ev)
    db.commit()
    db.refresh(dispatch)
    return dispatch
