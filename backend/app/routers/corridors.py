from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.corridor_public import list_active_corridors_for_public
from app.database import get_db
from app.models import Corridor, Incident, Organisation, User, Vehicle
from app.schemas import (
    CorridorCreate,
    CorridorOut,
    CorridorPublicOut,
    CorridorStatsOut,
    CorridorUpdate,
    IncidentListItem,
    PublicIncidentCreate,
    PublicIncidentResponse,
    VehicleMapOut,
)
from app.security import get_current_user, require_role
from app.services.public_incident import create_public_incident_row
from app.services.corridor_detection import detect_corridor
from app.services.incident_lifecycle import expire_stale_open_incidents, incident_eligible_for_operator_reassign
from app.routers.incidents import _push_corridor_stats, _push_incident_new

router = APIRouter(prefix="/corridors", tags=["corridors"])

admin_only = require_role("admin")

SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2}
_HIGHWAY_HINT_RE = re.compile(r"\bNH\s*-?\s*\d{1,4}\b", re.IGNORECASE)


def _severity_rank(sev: str) -> int:
    return SEVERITY_ORDER.get(sev.lower(), 9)


def _default_organisation_id(db: Session) -> uuid.UUID:
    oid = db.execute(select(Organisation.id).limit(1)).scalar_one_or_none()
    if oid is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No organisation in database; run seed first",
        )
    return oid


def _hint_from_body(body: PublicIncidentCreate) -> str | None:
    if body.highway_hint and body.highway_hint.strip():
        return body.highway_hint.strip()
    for raw in (body.notes, body.incident_type):
        if not raw:
            continue
        m = _HIGHWAY_HINT_RE.search(raw)
        if m:
            return m.group(0)
    return None


@router.get("", response_model=list[CorridorOut])
def list_corridors(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Corridor).where(Corridor.is_active.is_(True)).order_by(Corridor.name)
    rows = db.execute(q).scalars().all()
    return [CorridorOut.model_validate(r) for r in rows]


@router.post("", response_model=CorridorOut)
def create_corridor(
    data: CorridorCreate,
    db: Session = Depends(get_db),
    _: User = Depends(admin_only),
):
    org_id = data.organisation_id or _default_organisation_id(db)
    code_val = data.code.strip() if data.code else None
    if code_val == "":
        code_val = None
    corridor = Corridor(
        organisation_id=org_id,
        name=data.name.strip(),
        code=code_val,
        km_start=data.km_start,
        km_end=data.km_end,
        is_active=data.active,
        start_lat=data.start_lat,
        start_lng=data.start_lng,
        end_lat=data.end_lat,
        end_lng=data.end_lng,
        waypoints=data.waypoints,
    )
    db.add(corridor)
    db.commit()
    db.refresh(corridor)
    return CorridorOut.model_validate(corridor)


@router.get("/public", response_model=list[CorridorPublicOut])
def list_corridors_public(db: Session = Depends(get_db)):
    """Active corridors for public emergency reporting (alias path)."""
    return list_active_corridors_for_public(db)


@router.put("/{corridor_id}", response_model=CorridorOut)
def update_corridor(
    corridor_id: uuid.UUID,
    data: CorridorUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(admin_only),
):
    corridor = db.get(Corridor, corridor_id)
    if not corridor:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")
    patch = data.model_dump(exclude_unset=True)
    if "active" in patch:
        corridor.is_active = patch.pop("active")
    if "name" in patch:
        corridor.name = patch.pop("name").strip()
    if "code" in patch:
        c = patch.pop("code")
        corridor.code = c.strip() if c else None
    for key in ("km_start", "km_end", "start_lat", "start_lng", "end_lat", "end_lng", "waypoints"):
        if key in patch:
            setattr(corridor, key, patch.pop(key))
    db.commit()
    db.refresh(corridor)
    return CorridorOut.model_validate(corridor)


@router.delete("/{corridor_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_corridor(
    corridor_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(admin_only),
):
    corridor = db.get(Corridor, corridor_id)
    if not corridor:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")
    corridor.is_active = False
    db.commit()
    return None


@router.get("/{corridor_id}/stats", response_model=CorridorStatsOut)
def corridor_stats(
    corridor_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    active = db.execute(
        select(func.count()).select_from(Incident).where(
            Incident.corridor_id == corridor_id,
            Incident.status.notin_(["closed", "cancelled", "recalled", "archived"]),
        )
    ).scalar_one()
    pending = db.execute(
        select(func.count()).select_from(Incident).where(
            Incident.corridor_id == corridor_id,
            Incident.status.in_(["open", "verifying"]),
        )
    ).scalar_one()
    avail = db.execute(
        select(func.count()).select_from(Vehicle).where(
            Vehicle.corridor_id == corridor_id,
            Vehicle.is_available.is_(True),
            Vehicle.status == "available",
        )
    ).scalar_one()
    # Stub average until SLA table wired; optional SQL from closed incidents
    avg = db.execute(
        text(
            """
            SELECT AVG(EXTRACT(EPOCH FROM (i.updated_at - i.created_at)) / 60.0)
            FROM incidents i
            WHERE i.corridor_id = :cid AND i.status = 'closed'
            """
        ),
        {"cid": str(corridor_id)},
    ).scalar()
    return CorridorStatsOut(
        active_incidents=int(active),
        pending_dispatch=int(pending),
        available_vehicles=int(avail),
        avg_response_time_minutes=float(avg) if avg is not None else None,
    )


@router.get("/{corridor_id}/incidents", response_model=list[IncidentListItem])
def list_incidents(
    corridor_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    expire_stale_open_incidents(db)
    q = (
        select(Incident, Incident.lat.label("lat"), Incident.lng.label("lng"))
        .where(Incident.corridor_id == corridor_id)
            .where(Incident.status.notin_(["closed", "cancelled", "archived"]))
    )
    rows = db.execute(q).all()
    items: list[IncidentListItem] = []
    for inc, lat, lng in rows:
        eligible = incident_eligible_for_operator_reassign(db, inc.id)
        items.append(
            IncidentListItem(
                id=inc.id,
                corridor_id=inc.corridor_id,
                incident_type=inc.incident_type,
                severity=inc.severity,
                km_marker=inc.km_marker,
                latitude=float(lat) if lat is not None else None,
                longitude=float(lng) if lng is not None else None,
                trust_score=inc.trust_score,
                trust_recommendation=inc.trust_recommendation,
                trust_factors=list(inc.trust_factors or []),
                status=inc.status,
                reporter_type=inc.reporter_type,
                injured_count=inc.injured_count,
                notes=inc.notes,
                public_report_id=inc.public_report_id,
                created_at=inc.created_at,
                updated_at=inc.updated_at,
                eligible_for_reassign=eligible,
            )
        )
    # Critical → Major → Minor; within same severity, oldest first (longest waiting).
    items.sort(key=lambda x: x.created_at)
    items.sort(key=lambda x: _severity_rank(x.severity))
    return items


@router.get("/{corridor_id}/vehicles", response_model=list[VehicleMapOut])
def list_vehicles(
    corridor_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = (
        select(Vehicle, Vehicle.lat.label("lat"), Vehicle.lng.label("lng"), User.phone)
        .where(Vehicle.corridor_id == corridor_id)
        .outerjoin(User, User.id == Vehicle.driver_user_id)
    )
    out: list[VehicleMapOut] = []
    for v, lat, lng, driver_phone in db.execute(q).all():
        out.append(
            VehicleMapOut(
                id=v.id,
                label=v.label,
                vehicle_type=v.vehicle_type,
                status=v.status,
                is_available=v.is_available,
                latitude=float(lat) if lat is not None else None,
                longitude=float(lng) if lng is not None else None,
                updated_at=v.updated_at,
                driver_phone=str(driver_phone) if driver_phone else None,
            )
        )
    return out


@router.post("/{corridor_id}/incidents/public", response_model=PublicIncidentResponse)
def post_public_incident(
    corridor_id: uuid.UUID,
    body: PublicIncidentCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    if not db.get(Corridor, corridor_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")
    result = create_public_incident_row(db, corridor_id, body)
    background_tasks.add_task(_push_incident_new, corridor_id, {"incident_id": str(result.incident_id)})
    background_tasks.add_task(_push_corridor_stats, corridor_id)
    return result


@router.post("/incidents/public", response_model=PublicIncidentResponse)
def post_public_incident_auto_corridor(
    body: PublicIncidentCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    corridor_id = body.corridor_id
    if corridor_id is None:
        det = detect_corridor(
            db,
            lat=body.latitude,
            lng=body.longitude,
            km_marker=body.km_marker,
            highway_hint=_hint_from_body(body),
        )
        if det is not None:
            corridor_id = det.corridor_id
    if corridor_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not auto-detect corridor. Provide corridor_id or add GPS/KM/highway hint.",
        )
    if not db.get(Corridor, corridor_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")
    result = create_public_incident_row(db, corridor_id, body)
    background_tasks.add_task(_push_incident_new, corridor_id, {"incident_id": str(result.incident_id)})
    background_tasks.add_task(_push_corridor_stats, corridor_id)
    return result


