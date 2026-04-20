from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.incident_lifecycle import expire_stale_open_incidents


def sync_vehicle_statuses_with_incidents(db: Session, *, commit: bool = True) -> int:
    """Reset vehicles that are not tied to an active in-flight incident assignment.

    A vehicle is "on a job" only when it is the latest dispatched unit for an incident whose
    status is one of dispatched / en_route / on_scene / transporting (not closed, expired,
    open queue, etc.).
    """
    r = db.execute(
        text(
            """
            UPDATE vehicles v
            SET status = 'available',
                is_available = true,
                updated_at = now()
            WHERE (
                v.status IN ('dispatched', 'en_route', 'on_scene', 'transporting')
                OR (v.status = 'available' AND COALESCE(v.is_available, true) IS false)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM incidents i
                INNER JOIN LATERAL (
                  SELECT d.vehicle_id
                  FROM dispatches d
                  WHERE d.incident_id = i.id
                  ORDER BY d.created_at DESC
                  LIMIT 1
                ) ld ON ld.vehicle_id = v.id
                WHERE i.status IN ('dispatched', 'en_route', 'on_scene', 'transporting')
              )
            """
        )
    )
    n = r.rowcount or 0
    if commit:
        db.commit()
    return int(n)


def run_maintenance_cycle(
    db: Session,
) -> tuple[dict[str, int], list[tuple[uuid.UUID, str, uuid.UUID, uuid.UUID]]]:
    """Expire stale queue items, sync vehicle rows, then auto-dispatch."""
    expired = expire_stale_open_incidents(db, commit=True)
    released = sync_vehicle_statuses_with_incidents(db, commit=True)
    from app.services.auto_dispatch import process_auto_dispatch_candidates

    notifications = process_auto_dispatch_candidates(db)
    metrics = {
        "expired_incidents": expired,
        "vehicles_released": released,
        "auto_dispatched": len(notifications),
    }
    return metrics, notifications
