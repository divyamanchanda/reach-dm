from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Corridor, Incident, User, Vehicle
from app.schemas import (
    IncidentDetailOut,
    VehicleIncidentHistoryItem,
    VehicleLocationBody,
    VehicleMineOut,
    VehicleStatusBody,
)
from app.security import get_current_user, require_role
from app.services.audit_log import log_audit
from app.routers.incidents import incident_to_detail_out
from app.socket_server import emit_to_corridor

router = APIRouter(prefix="/vehicles", tags=["vehicles"])


async def _push_vehicle_location(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("vehicle:location", corridor_id, payload)


async def _push_vehicle_status(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("vehicle:status", corridor_id, payload)


@router.get("/mine", response_model=list[VehicleMineOut])
def list_my_vehicles(
    db: Session = Depends(get_db),
    user: User = Depends(require_role("driver")),
):
    """Vehicles assigned to this driver (App3 — no manual vehicle search)."""
    rows = db.execute(
        select(Vehicle, Corridor.name)
        .join(Corridor, Vehicle.corridor_id == Corridor.id)
        .where(Vehicle.driver_user_id == user.id)
        .order_by(Vehicle.label)
    ).all()
    return [
        VehicleMineOut(
            id=v.id,
            corridor_id=v.corridor_id,
            corridor_name=cname,
            label=v.label,
            status=v.status,
            vehicle_type=v.vehicle_type,
        )
        for v, cname in rows
    ]


@router.get("/{vehicle_id}/incidents/history", response_model=list[VehicleIncidentHistoryItem])
def list_vehicle_incident_history(
    vehicle_id: uuid.UUID,
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(require_role("driver")),
):
    """Last N incidents this vehicle was dispatched to (includes closed)."""
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    if v.driver_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your vehicle")
    rows = db.execute(
        text(
            """
            SELECT i.id, i.incident_type, i.status, i.created_at
            FROM incidents i
            WHERE i.id IN (SELECT DISTINCT incident_id FROM dispatches WHERE vehicle_id = :vid)
            ORDER BY i.updated_at DESC NULLS LAST, i.created_at DESC
            LIMIT :lim
            """
        ),
        {"vid": str(vehicle_id), "lim": limit},
    ).mappings().all()
    return [
        VehicleIncidentHistoryItem(
            id=r["id"],
            incident_type=r["incident_type"],
            status=r["status"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.get("/{vehicle_id}/incidents", response_model=list[IncidentDetailOut])
def list_vehicle_dispatched_incidents(
    vehicle_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("driver")),
):
    """Active dispatches for this vehicle (polled by App3 every few seconds)."""
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    if v.driver_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your vehicle")
    id_rows = db.execute(
        text(
            """
            SELECT i.id
            FROM incidents i
            INNER JOIN dispatches d ON d.incident_id = i.id AND d.vehicle_id = :vid
            WHERE i.status NOT IN ('closed', 'cancelled', 'archived', 'expired', 'recalled')
            ORDER BY d.created_at DESC
            LIMIT 10
            """
        ),
        {"vid": str(vehicle_id)},
    ).scalars().all()
    if not id_rows:
        return []
    stmt = select(Incident).where(Incident.id.in_(id_rows)).options(selectinload(Incident.events))
    by_id = {inc.id: inc for inc in db.execute(stmt).scalars().all()}
    return [incident_to_detail_out(db, by_id[iid]) for iid in id_rows if iid in by_id]


@router.patch("/{vehicle_id}/location")
def patch_vehicle_location(
    vehicle_id: uuid.UUID,
    body: VehicleLocationBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    db.execute(
        text(
            """
            UPDATE vehicles
            SET lat = :lat, lng = :lng, updated_at = now()
            WHERE id = :id
            """
        ),
        {"lng": body.longitude, "lat": body.latitude, "id": str(vehicle_id)},
    )
    db.commit()
    payload = {
        "vehicle_id": str(vehicle_id),
        "latitude": body.latitude,
        "longitude": body.longitude,
    }
    background_tasks.add_task(_push_vehicle_location, v.corridor_id, payload)
    return {"ok": True}


@router.patch("/{vehicle_id}/status")
def patch_vehicle_status(
    vehicle_id: uuid.UUID,
    body: VehicleStatusBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    v = db.get(Vehicle, vehicle_id)
    if not v:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vehicle not found")
    v.status = body.status
    v.is_available = body.status == "available"
    db.commit()
    log_audit(
        user=user,
        action="vehicle_status_changed",
        entity_type="vehicle",
        entity_id=vehicle_id,
        details={"status": body.status, "is_available": v.is_available},
    )
    background_tasks.add_task(
        _push_vehicle_status,
        v.corridor_id,
        {"vehicle_id": str(vehicle_id), "status": body.status},
    )
    return {"ok": True}
