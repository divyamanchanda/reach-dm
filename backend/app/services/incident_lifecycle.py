from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Dispatch, Incident, IncidentEvent, User

# Unassigned queue items auto-expire after this many hours (App1 dispatch console).
INCIDENT_EXPIRE_HOURS = 2

# Operator may reassign if no driver accept in this many minutes after dispatch.
REASSIGN_AFTER_DISPATCH_MINUTES = 2


def expire_stale_open_incidents(db: Session, *, commit: bool = True) -> int:
    """Set status to 'expired' for old incidents still in pre-dispatch queue."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=INCIDENT_EXPIRE_HOURS)
    r = db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'expired', updated_at = now()
            WHERE created_at < :cutoff
              AND status IN ('open', 'verifying', 'confirmed_real')
            """
        ),
        {"cutoff": cutoff},
    )
    n = r.rowcount or 0
    if commit:
        db.commit()
    return n


def declined_vehicle_ids_for_incident(db: Session, incident_id: uuid.UUID) -> set[uuid.UUID]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT (payload->>'vehicle_id')::uuid AS vid
            FROM incident_events
            WHERE incident_id = :iid
              AND event_type = 'vehicle_declined'
              AND payload->>'vehicle_id' IS NOT NULL
            """
        ),
        {"iid": str(incident_id)},
    ).fetchall()
    out: set[uuid.UUID] = set()
    for (vid,) in rows:
        if vid is not None:
            out.add(vid)
    return out


def latest_dispatch_vehicle_id(db: Session, incident_id: uuid.UUID) -> uuid.UUID | None:
    row = db.execute(
        text(
            """
            SELECT vehicle_id FROM dispatches
            WHERE incident_id = :iid
            ORDER BY created_at DESC
            LIMIT 1
            """
        ),
        {"iid": str(incident_id)},
    ).scalar_one_or_none()
    return row


def driver_decline_incident(db: Session, user: User, incident_id: uuid.UUID) -> None:
    """Driver refuses the current assignment: free vehicle, return incident to open queue."""
    v_row = db.execute(
        text("SELECT id FROM vehicles WHERE driver_user_id = :uid LIMIT 1"),
        {"uid": str(user.id)},
    ).scalar_one_or_none()
    if not v_row:
        raise ValueError("No vehicle is assigned to your account")
    vehicle_id = v_row if isinstance(v_row, uuid.UUID) else uuid.UUID(str(v_row))

    row = db.execute(
        text(
            """
            SELECT 1 FROM dispatches
            WHERE incident_id = :iid AND vehicle_id = :vid
            LIMIT 1
            """
        ),
        {"iid": str(incident_id), "vid": str(vehicle_id)},
    ).first()
    if not row:
        raise ValueError("You are not dispatched to this incident")

    inc = db.get(Incident, incident_id)
    if not inc:
        raise ValueError("Incident not found")
    if inc.status in ("closed", "cancelled", "recalled", "expired", "archived"):
        raise ValueError("Incident is not active")

    db.execute(
        text("DELETE FROM dispatches WHERE incident_id = :iid AND vehicle_id = :vid"),
        {"iid": str(incident_id), "vid": str(vehicle_id)},
    )
    db.execute(
        text(
            """
            UPDATE vehicles
            SET status = 'available', is_available = true, updated_at = now()
            WHERE id = :vid
            """
        ),
        {"vid": str(vehicle_id)},
    )
    inc.status = "open"
    db.add(
        IncidentEvent(
            incident_id=incident_id,
            event_type="vehicle_declined",
            payload={"vehicle_id": str(vehicle_id), "by": str(user.id)},
        )
    )
    db.commit()


def incident_eligible_for_operator_reassign(db: Session, incident_id: uuid.UUID) -> bool:
    """True if dispatch timed out without accept, or a driver declined."""
    inc = db.get(Incident, incident_id)
    if not inc or inc.status in ("closed", "cancelled", "recalled", "expired", "archived"):
        return False

    if inc.status == "open":
        # Declined — ready for one-click reassign
        ev = db.execute(
            text(
                """
                SELECT 1 FROM incident_events
                WHERE incident_id = :iid AND event_type = 'vehicle_declined'
                LIMIT 1
                """
            ),
            {"iid": str(incident_id)},
        ).first()
        return ev is not None

    if inc.status != "dispatched":
        return False

    last = db.execute(
        text(
            """
            SELECT MAX(created_at) FROM dispatches WHERE incident_id = :iid
            """
        ),
        {"iid": str(incident_id)},
    ).scalar_one_or_none()
    if last is None:
        return False
    if isinstance(last, datetime):
        dt = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
    else:
        return False
    deadline = dt + timedelta(minutes=REASSIGN_AFTER_DISPATCH_MINUTES)
    if datetime.now(timezone.utc) < deadline:
        return False
    # Still dispatched and past window — driver never accepted
    return inc.status == "dispatched"


def reassign_incident(db: Session, incident_id: uuid.UUID) -> Dispatch:
    """Next-nearest dispatch after decline or dispatch timeout; excludes declined and timed-out vehicle."""
    from app.services.dispatch import run_dispatch
    from app.services.public_incident import list_nearby_ambulances

    if not incident_eligible_for_operator_reassign(db, incident_id):
        raise ValueError("Incident is not eligible for reassignment")

    inc = db.get(Incident, incident_id)
    if not inc:
        raise ValueError("Incident not found")

    declined = declined_vehicle_ids_for_incident(db, incident_id)
    latest_vid = latest_dispatch_vehicle_id(db, incident_id)

    if inc.status == "dispatched" and latest_vid is not None:
        rows = db.execute(
            text("SELECT DISTINCT vehicle_id FROM dispatches WHERE incident_id = :iid"),
            {"iid": str(incident_id)},
        ).fetchall()
        for (vid,) in rows:
            if vid is None:
                continue
            db.execute(
                text(
                    """
                    UPDATE vehicles
                    SET status = 'available', is_available = true, updated_at = now()
                    WHERE id = :vid
                    """
                ),
                {"vid": str(vid)},
            )
        db.execute(text("DELETE FROM dispatches WHERE incident_id = :iid"), {"iid": str(incident_id)})
        inc.status = "open"
        db.flush()

    exclude: set[uuid.UUID] = set(declined)
    if latest_vid is not None:
        exclude.add(latest_vid)

    nearby = list_nearby_ambulances(db, incident_id, limit=20, exclude_vehicle_ids=exclude)
    if not nearby:
        db.rollback()
        raise ValueError("No available vehicle to reassign")

    pick = nearby[0].vehicle_id
    return run_dispatch(db, incident_id=incident_id, vehicle_id=pick)
