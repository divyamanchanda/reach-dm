from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Corridor, Dispatch, Incident, IncidentEvent, Organisation, User, Vehicle
from app.schemas import (
    AdminCorridorCreateBody,
    AdminDashboardOut,
    AdminIncidentDetailOut,
    AdminRecentIncidentItem,
    AdminUserCreateBody,
    CorridorOut,
    LiveMapCorridorOut,
    LiveMapIncidentOut,
    LiveMapOut,
    LiveMapVehicleOut,
    OrganisationMiniOut,
    UserPublic,
)
from app.security import hash_password, require_role

router = APIRouter(prefix="/admin", tags=["admin"])

admin_user = require_role("admin", "dispatch_operator")


def _default_organisation_id(db: Session) -> uuid.UUID:
    oid = db.execute(select(Organisation.id).limit(1)).scalar_one_or_none()
    if oid is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No organisation in database; run seed first",
        )
    return oid


@router.get("/dashboard", response_model=AdminDashboardOut)
def admin_dashboard(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    active = db.execute(
        select(func.count()).select_from(Incident).where(
            Incident.status.notin_(["closed", "cancelled", "recalled"]),
        )
    ).scalar_one()
    v_count = db.execute(select(func.count()).select_from(Vehicle)).scalar_one()
    c_count = db.execute(select(func.count()).select_from(Corridor)).scalar_one()
    return AdminDashboardOut(
        active_incidents=int(active),
        total_vehicles=int(v_count),
        total_corridors=int(c_count),
    )


@router.get("/incidents/recent", response_model=list[AdminRecentIncidentItem])
def admin_recent_incidents(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
    limit: int = Query(10, ge=1, le=50),
):
    q = (
        select(Incident, Corridor.name)
        .join(Corridor, Incident.corridor_id == Corridor.id)
        .order_by(Incident.created_at.desc())
        .limit(limit)
    )
    out: list[AdminRecentIncidentItem] = []
    for inc, corridor_name in db.execute(q).all():
        out.append(
            AdminRecentIncidentItem(
                id=inc.id,
                corridor_id=inc.corridor_id,
                corridor_name=corridor_name,
                incident_type=inc.incident_type,
                severity=inc.severity,
                status=inc.status,
                km_marker=inc.km_marker,
                created_at=inc.created_at,
            )
        )
    return out


@router.get("/incidents/{incident_id}", response_model=AdminIncidentDetailOut)
def admin_incident_detail(
    incident_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")

    last_dispatch = db.execute(
        select(Dispatch, Vehicle.label)
        .join(Vehicle, Dispatch.vehicle_id == Vehicle.id)
        .where(Dispatch.incident_id == incident_id)
        .order_by(Dispatch.created_at.desc())
        .limit(1)
    ).first()
    assigned_vehicle_label = last_dispatch[1] if last_dispatch else None

    timeline = db.execute(
        select(IncidentEvent)
        .where(IncidentEvent.incident_id == incident_id)
        .order_by(IncidentEvent.created_at.asc())
    ).scalars().all()

    return AdminIncidentDetailOut(
        id=incident.id,
        incident_type=incident.incident_type,
        severity=incident.severity,
        status=incident.status,
        trust_score=incident.trust_score,
        km_marker=incident.km_marker,
        public_report_id=incident.public_report_id,
        created_at=incident.created_at,
        assigned_vehicle_label=assigned_vehicle_label,
        timeline=timeline,
    )


@router.get("/users", response_model=list[UserPublic])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    rows = db.execute(select(User).order_by(User.phone)).scalars().all()
    return [UserPublic.model_validate(r) for r in rows]


@router.post("/users", response_model=UserPublic)
def create_user(
    body: AdminUserCreateBody,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    exists = db.execute(select(User.id).where(User.phone == body.phone)).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Phone already registered")
    org_id = body.organisation_id or _default_organisation_id(db)
    user = User(
        organisation_id=org_id,
        phone=body.phone,
        password_hash=hash_password(body.password),
        full_name=body.full_name,
        role=body.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserPublic.model_validate(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current: User = Depends(admin_user),
):
    if user_id == current.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    db.delete(user)
    db.commit()
    return None


@router.get("/corridors", response_model=list[CorridorOut])
def list_corridors_admin(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    rows = db.execute(select(Corridor).order_by(Corridor.name)).scalars().all()
    return [CorridorOut.model_validate(r) for r in rows]


@router.post("/corridors", response_model=CorridorOut)
def create_corridor(
    body: AdminCorridorCreateBody,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    org_id = body.organisation_id or _default_organisation_id(db)
    corridor = Corridor(
        organisation_id=org_id,
        name=body.name,
        code=body.code,
        start_lat=body.start_lat,
        start_lng=body.start_lng,
        end_lat=body.end_lat,
        end_lng=body.end_lng,
        km_start=0.0,
        km_end=body.km_length,
        is_active=True,
    )
    db.add(corridor)
    db.commit()
    db.refresh(corridor)
    return CorridorOut.model_validate(corridor)


@router.delete("/corridors/{corridor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_corridor(
    corridor_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    corridor = db.get(Corridor, corridor_id)
    if not corridor:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")

    inc_subq = select(Incident.id).where(Incident.corridor_id == corridor_id)
    veh_subq = select(Vehicle.id).where(Vehicle.corridor_id == corridor_id)
    db.execute(
        delete(Dispatch).where(
            or_(
                Dispatch.incident_id.in_(inc_subq),
                Dispatch.vehicle_id.in_(veh_subq),
            )
        )
    )
    db.execute(delete(IncidentEvent).where(IncidentEvent.incident_id.in_(inc_subq)))
    db.execute(delete(Incident).where(Incident.corridor_id == corridor_id))
    db.execute(delete(Vehicle).where(Vehicle.corridor_id == corridor_id))
    db.delete(corridor)
    db.commit()
    return None


@router.get("/organisations", response_model=list[OrganisationMiniOut])
def list_organisations(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    rows = db.execute(select(Organisation).order_by(Organisation.name)).scalars().all()
    return [OrganisationMiniOut.model_validate(r) for r in rows]


@router.get("/live-map", response_model=LiveMapOut)
def admin_live_map(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    corridors = db.execute(select(Corridor).order_by(Corridor.name)).scalars().all()
    out_corridors: list[LiveMapCorridorOut] = []

    for c in corridors:
        qi = (
            select(Incident, Incident.lat.label("lat"), Incident.lng.label("lng"))
            .where(Incident.corridor_id == c.id)
            .where(Incident.status.notin_(["closed", "cancelled"]))
        )
        incidents: list[LiveMapIncidentOut] = []
        for inc, la, ln in db.execute(qi).all():
            incidents.append(
                LiveMapIncidentOut(
                    id=inc.id,
                    incident_type=inc.incident_type,
                    severity=inc.severity,
                    trust_score=inc.trust_score,
                    km_marker=inc.km_marker,
                    status=inc.status,
                    created_at=inc.created_at,
                    latitude=float(la) if la is not None else None,
                    longitude=float(ln) if ln is not None else None,
                    public_report_id=inc.public_report_id,
                )
            )

        qv = select(Vehicle, Vehicle.lat.label("lat"), Vehicle.lng.label("lng")).where(Vehicle.corridor_id == c.id)
        vehicles: list[LiveMapVehicleOut] = []
        for v, la, ln in db.execute(qv).all():
            assign_row = db.execute(
                select(Incident.km_marker, Incident.id)
                .join(Dispatch, Dispatch.incident_id == Incident.id)
                .where(Dispatch.vehicle_id == v.id)
                .order_by(Dispatch.created_at.desc())
                .limit(1)
            ).first()
            last_km = assign_row[0] if assign_row else None
            assign_incident_id = assign_row[1] if assign_row else None
            vehicles.append(
                LiveMapVehicleOut(
                    id=v.id,
                    label=v.label,
                    status=v.status,
                    km_marker=float(last_km) if last_km is not None else None,
                    latitude=float(la) if la is not None else None,
                    longitude=float(ln) if ln is not None else None,
                    assigned_incident_id=assign_incident_id,
                )
            )

        out_corridors.append(
            LiveMapCorridorOut(
                id=c.id,
                name=c.name,
                km_start=c.km_start,
                km_end=c.km_end,
                incidents=incidents,
                vehicles=vehicles,
            )
        )

    return LiveMapOut(corridors=out_corridors)
