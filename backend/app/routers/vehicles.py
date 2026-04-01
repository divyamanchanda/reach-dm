from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, Vehicle
from app.schemas import VehicleLocationBody, VehicleStatusBody
from app.security import get_current_user
from app.socket_server import emit_to_corridor

router = APIRouter(prefix="/vehicles", tags=["vehicles"])


async def _push_vehicle_location(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("vehicle:location", corridor_id, payload)


async def _push_vehicle_status(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("vehicle:status", corridor_id, payload)


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
            SET location = ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
                updated_at = now()
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
    background_tasks.add_task(
        _push_vehicle_status,
        v.corridor_id,
        {"vehicle_id": str(vehicle_id), "status": body.status},
    )
    return {"ok": True}
