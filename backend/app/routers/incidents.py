from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.geo_utils import incident_lat_lng
from app.models import Incident, IncidentEvent, User
from app.schemas import (
    DispatchBody,
    IncidentDetailOut,
    IncidentPatchBody,
    IncidentStatusBody,
    IncidentVerifyBody,
    NearbyVehicleOut,
    TimelineEventOut,
)
from app.security import get_current_user, require_role
from app.services.dispatch import run_dispatch
from app.services.incident_lifecycle import driver_decline_incident, reassign_incident
from app.services.public_incident import list_nearby_ambulances
from app.socket_server import emit_to_corridor

router = APIRouter(prefix="/incidents", tags=["incidents"])


def incident_to_detail_out(db: Session, inc: Incident) -> IncidentDetailOut:
    """Build API detail for an incident with timeline (shared with vehicle driver endpoints)."""
    lat, lng = incident_lat_lng(db, inc)
    timeline = [TimelineEventOut.model_validate(e) for e in inc.events]
    return IncidentDetailOut(
        id=inc.id,
        corridor_id=inc.corridor_id,
        incident_type=inc.incident_type,
        severity=inc.severity,
        km_marker=inc.km_marker,
        latitude=lat,
        longitude=lng,
        trust_score=inc.trust_score,
        trust_recommendation=inc.trust_recommendation,
        trust_factors=list(inc.trust_factors or []),
        status=inc.status,
        reporter_type=inc.reporter_type,
        injured_count=inc.injured_count,
        notes=inc.notes,
        photo_url=inc.photo_url,
        public_report_id=inc.public_report_id,
        created_at=inc.created_at,
        updated_at=inc.updated_at,
        timeline=timeline,
    )


async def _push_incident_new(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("incident:new", corridor_id, payload)


async def _push_incident_updated(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("incident:updated", corridor_id, payload)


async def _push_dispatched(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("incident:dispatched", corridor_id, payload)


async def _push_recalled(corridor_id: uuid.UUID, payload: dict) -> None:
    await emit_to_corridor("incident:recalled", corridor_id, payload)


async def _push_corridor_stats(corridor_id: uuid.UUID) -> None:
    await emit_to_corridor("corridor:stats", corridor_id, {"corridor_id": str(corridor_id)})


@router.get("/{incident_id}", response_model=IncidentDetailOut)
def get_incident(
    incident_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Incident).where(Incident.id == incident_id).options(selectinload(Incident.events))
    inc = db.execute(stmt).scalar_one_or_none()
    if not inc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    return incident_to_detail_out(db, inc)


@router.patch("/{incident_id}", response_model=IncidentDetailOut)
def patch_incident(
    incident_id: uuid.UUID,
    body: IncidentPatchBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _user: User = Depends(require_role("dispatch_operator")),
):
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update")
    inc = db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    if "notes" in data:
        inc.notes = data["notes"]
    db.commit()
    stmt = select(Incident).where(Incident.id == incident_id).options(selectinload(Incident.events))
    inc = db.execute(stmt).scalar_one()
    background_tasks.add_task(_push_incident_updated, inc.corridor_id, {"incident_id": str(incident_id)})
    background_tasks.add_task(_push_corridor_stats, inc.corridor_id)
    return incident_to_detail_out(db, inc)


@router.get("/{incident_id}/nearby-vehicles", response_model=list[NearbyVehicleOut])
def get_nearby_vehicles(
    incident_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("dispatch_operator")),
):
    if not db.get(Incident, incident_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    return list_nearby_ambulances(db, incident_id, limit=20)


@router.post("/{incident_id}/dispatch")
def dispatch_incident(
    incident_id: uuid.UUID,
    body: DispatchBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("dispatch_operator")),
):
    inc_before = db.get(Incident, incident_id)
    if not inc_before:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    cid = inc_before.corridor_id
    dispatch = run_dispatch(db, incident_id=incident_id, vehicle_id=body.vehicle_id)
    payload = {
        "incident_id": str(incident_id),
        "vehicle_id": str(body.vehicle_id),
        "dispatch_id": str(dispatch.id),
    }
    background_tasks.add_task(_push_dispatched, cid, payload)
    background_tasks.add_task(_push_corridor_stats, cid)
    return {"ok": True, "dispatch_id": str(dispatch.id)}


@router.post("/{incident_id}/decline")
def decline_incident(
    incident_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("driver")),
):
    try:
        driver_decline_incident(db, user, incident_id)
    except ValueError as e:
        msg = str(e)
        if "not found" in msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=msg) from e
        if "not assigned" in msg.lower() or "not dispatched" in msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=msg) from e
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg) from e
    inc = db.get(Incident, incident_id)
    if inc:
        background_tasks.add_task(_push_incident_updated, inc.corridor_id, {"incident_id": str(incident_id)})
        background_tasks.add_task(_push_corridor_stats, inc.corridor_id)
    return {"ok": True}


@router.patch("/{incident_id}/reassign")
def patch_reassign_incident(
    incident_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("dispatch_operator")),
):
    try:
        dispatch = reassign_incident(db, incident_id)
    except ValueError as e:
        msg = str(e)
        if "not found" in msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=msg) from e
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg) from e
    inc = db.get(Incident, incident_id)
    cid = inc.corridor_id if inc else None
    if cid:
        payload = {
            "incident_id": str(incident_id),
            "vehicle_id": str(dispatch.vehicle_id),
            "dispatch_id": str(dispatch.id),
        }
        background_tasks.add_task(_push_dispatched, cid, payload)
        background_tasks.add_task(_push_corridor_stats, cid)
    return {"ok": True, "dispatch_id": str(dispatch.id)}


@router.patch("/{incident_id}/status")
def patch_incident_status(
    incident_id: uuid.UUID,
    body: IncidentStatusBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inc = db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    inc.status = body.status
    db.add(
        IncidentEvent(
            incident_id=incident_id,
            event_type="status_change",
            payload={"status": body.status, "by": str(user.id)},
        )
    )
    db.commit()
    background_tasks.add_task(_push_incident_updated, inc.corridor_id, {"incident_id": str(incident_id)})
    background_tasks.add_task(_push_corridor_stats, inc.corridor_id)
    return {"ok": True}


@router.post("/{incident_id}/recall")
def recall_incident(
    incident_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("dispatch_operator")),
):
    inc = db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    inc.status = "recalled"
    db.add(
        IncidentEvent(
            incident_id=incident_id,
            event_type="incident_recalled",
            payload={"status": "recalled", "by": str(user.id)},
        )
    )
    dispatched_vehicle = db.execute(
        text(
            """
            SELECT d.vehicle_id
            FROM dispatches d
            WHERE d.incident_id = :iid
            ORDER BY d.created_at DESC
            LIMIT 1
            """
        ),
        {"iid": str(incident_id)},
    ).mappings().first()
    if dispatched_vehicle:
        db.execute(
            text(
                """
                UPDATE vehicles
                SET status = 'available', is_available = true, updated_at = now()
                WHERE id = :vid
                """
            ),
            {"vid": str(dispatched_vehicle["vehicle_id"])},
        )
    payload = {"incident_id": str(incident_id)}
    if dispatched_vehicle:
        payload["vehicle_id"] = str(dispatched_vehicle["vehicle_id"])
    db.commit()
    background_tasks.add_task(_push_recalled, inc.corridor_id, payload)
    background_tasks.add_task(_push_incident_updated, inc.corridor_id, {"incident_id": str(incident_id)})
    background_tasks.add_task(_push_corridor_stats, inc.corridor_id)
    return {"ok": True, "status": "recalled"}


@router.post("/{incident_id}/verify")
def verify_incident(
    incident_id: uuid.UUID,
    body: IncidentVerifyBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    inc = db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    inc.trust_score = body.trust_score
    inc.status = body.status
    db.add(
        IncidentEvent(
            incident_id=incident_id,
            event_type="incident_verified",
            payload={"trust_score": body.trust_score, "status": body.status, "by": str(user.id)},
        )
    )
    db.commit()
    background_tasks.add_task(_push_incident_updated, inc.corridor_id, {"incident_id": str(incident_id)})
    background_tasks.add_task(_push_corridor_stats, inc.corridor_id)
    return {"ok": True, "incident_id": str(incident_id), "trust_score": body.trust_score, "status": body.status}
