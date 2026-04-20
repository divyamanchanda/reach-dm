from __future__ import annotations

import csv
import io
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from app.database import get_db
from app.geo_utils import incident_lat_lng, nh48_km_from_lat_lng
from app.models import (
    ApiRequestLog,
    AuditLog,
    BroadcastMessage,
    Corridor,
    Dispatch,
    Incident,
    IncidentEvent,
    Organisation,
    SpeedZone,
    User,
    Vehicle,
)
from app.schemas import (
    AdminAnalyticsCoverageOut,
    AdminAnalyticsFleetOut,
    AdminAnalyticsOut,
    AdminAnalyticsVehiclePerformanceOut,
    AdminArchiveStaleOut,
    AdminCorridorCreateBody,
    AdminDashboardOut,
    AdminIncidentDetailOut,
    AdminRecentIncidentItem,
    AdminVehicleDashboardOut,
    AdminUserCreateBody,
    AnalyticsIncidentRowOut,
    ApiRequestLogOut,
    AuditLogEntryOut,
    BroadcastBody,
    CorridorOut,
    LiveMapCorridorOut,
    LiveMapIncidentOut,
    LiveMapOut,
    LiveMapVehicleOut,
    OrganisationMiniOut,
    SpeedZoneCreateBody,
    SpeedZoneOut,
    SpeedZonePatchBody,
    UserPublic,
)
from app.security import hash_password, require_role
from app.services.audit_log import log_audit
from app.services.vehicle_sync import sync_vehicle_statuses_with_incidents

router = APIRouter(prefix="/admin", tags=["admin"])

admin_user = require_role("admin", "dispatch_operator")

_ACTIVE_STATUSES_EXCLUDE = ("closed", "cancelled", "recalled", "archived")


def _analytics_windows(period: str, now: datetime) -> tuple[datetime, datetime, datetime, datetime, str]:
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = now
        prev_end = start
        prev_start = start - timedelta(days=1)
        label = "yesterday"
    elif period == "7d":
        end = now
        start = now - timedelta(days=7)
        prev_end = start
        prev_start = now - timedelta(days=14)
        label = "prior 7 days"
    else:
        end = now
        start = now - timedelta(days=30)
        prev_end = start
        prev_start = now - timedelta(days=60)
        label = "prior 30 days"
    return start, end, prev_start, prev_end, label


def _analytics_incident_rows(db: Session, start: datetime, end: datetime) -> list[AnalyticsIncidentRowOut]:
    rows = db.execute(
        text(
            """
            SELECT i.id, i.incident_type, i.severity, i.status, i.created_at, i.km_marker, i.lat, i.lng,
              (SELECT EXTRACT(EPOCH FROM (MIN(d.created_at) - i.created_at)) / 60.0
               FROM dispatches d WHERE d.incident_id = i.id) AS resp_min,
              (SELECT EXTRACT(EPOCH FROM (MIN(ie.created_at) - i.created_at)) / 60.0
               FROM incident_events ie
               WHERE ie.incident_id = i.id
                 AND ie.event_type = 'status_change'
                 AND LOWER(COALESCE(ie.payload->>'status', '')) = 'on_scene') AS scene_min
            FROM incidents i
            WHERE i.created_at >= :start AND i.created_at < :end
            ORDER BY i.created_at ASC
            """
        ),
        {"start": start, "end": end},
    ).fetchall()
    out: list[AnalyticsIncidentRowOut] = []
    for rid, itype, sev, st, created, km, la, ln, resp, scene in rows:
        rm = round(float(resp), 2) if resp is not None else None
        sm = round(float(scene), 2) if scene is not None else None
        out.append(
            AnalyticsIncidentRowOut(
                id=rid,
                incident_type=itype,
                severity=sev,
                status=st,
                created_at=created,
                km_marker=float(km) if km is not None else None,
                latitude=float(la) if la is not None else None,
                longitude=float(ln) if ln is not None else None,
                first_response_minutes=rm,
                time_to_scene_minutes=sm,
            )
        )
    return out


_HISTORICAL_INCIDENTS_CAP = 8000


def _analytics_incident_rows_historical(db: Session, end: datetime, limit: int = _HISTORICAL_INCIDENTS_CAP) -> list[AnalyticsIncidentRowOut]:
    """Recent incidents up to `end`, newest first in query then returned chronological (for charts)."""
    rows = db.execute(
        text(
            """
            SELECT i.id, i.incident_type, i.severity, i.status, i.created_at, i.km_marker, i.lat, i.lng,
              (SELECT EXTRACT(EPOCH FROM (MIN(d.created_at) - i.created_at)) / 60.0
               FROM dispatches d WHERE d.incident_id = i.id) AS resp_min,
              (SELECT EXTRACT(EPOCH FROM (MIN(ie.created_at) - i.created_at)) / 60.0
               FROM incident_events ie
               WHERE ie.incident_id = i.id
                 AND ie.event_type = 'status_change'
                 AND LOWER(COALESCE(ie.payload->>'status', '')) = 'on_scene') AS scene_min
            FROM incidents i
            WHERE i.created_at < :end
            ORDER BY i.created_at DESC
            LIMIT :limit
            """
        ),
        {"end": end, "limit": limit},
    ).fetchall()
    out: list[AnalyticsIncidentRowOut] = []
    for rid, itype, sev, st, created, km, la, ln, resp, scene in reversed(rows):
        rm = round(float(resp), 2) if resp is not None else None
        sm = round(float(scene), 2) if scene is not None else None
        out.append(
            AnalyticsIncidentRowOut(
                id=rid,
                incident_type=itype,
                severity=sev,
                status=st,
                created_at=created,
                km_marker=float(km) if km is not None else None,
                latitude=float(la) if la is not None else None,
                longitude=float(ln) if ln is not None else None,
                first_response_minutes=rm,
                time_to_scene_minutes=sm,
            )
        )
    return out


def _fleet_breakdown(db: Session) -> AdminAnalyticsFleetOut:
    rows = db.execute(select(Vehicle.status)).scalars().all()
    avail = disp = off = 0
    for raw in rows:
        s = (raw or "").lower()
        if s in ("available", "idle"):
            avail += 1
        elif s in ("dispatched", "en_route", "on_scene", "transporting"):
            disp += 1
        else:
            off += 1
    return AdminAnalyticsFleetOut(available=avail, dispatched=disp, offline=off)


def _coverage_stats(db: Session) -> AdminAnalyticsCoverageOut:
    n, km = db.execute(
        text(
            """
            SELECT COUNT(*)::int AS n,
              COALESCE(SUM(GREATEST(km_end - km_start, 0)), 0)::double precision AS km
            FROM corridors
            WHERE is_active = true
            """
        )
    ).one()
    return AdminAnalyticsCoverageOut(active_corridors=int(n), km_monitored=round(float(km or 0.0), 1))


def _vehicle_performance_for_period(db: Session, start: datetime, end: datetime) -> list[AdminAnalyticsVehiclePerformanceOut]:
    rows = db.execute(
        text(
            """
            SELECT v.id, v.label, v.status, v.lat, v.lng,
              COALESCE(NULLIF(TRIM(COALESCE(u.full_name, '')), ''), u.phone, '') AS driver_display,
              COALESCE(perf.dispatch_count, 0)::int AS dispatch_count,
              perf.avg_response_minutes,
              perf.best_response_minutes
            FROM vehicles v
            LEFT JOIN users u ON u.id = v.driver_user_id
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::int AS dispatch_count,
                AVG(EXTRACT(EPOCH FROM (d.created_at - i.created_at)) / 60.0) AS avg_response_minutes,
                MIN(EXTRACT(EPOCH FROM (d.created_at - i.created_at)) / 60.0) AS best_response_minutes
              FROM dispatches d
              INNER JOIN incidents i ON i.id = d.incident_id
              WHERE d.vehicle_id = v.id
                AND i.created_at >= :start AND i.created_at < :end
            ) perf ON true
            ORDER BY v.label
            """
        ),
        {"start": start, "end": end},
    ).fetchall()
    out: list[AdminAnalyticsVehiclePerformanceOut] = []
    for vid, label, st, vlat, vlng, driver_display, dcount, avg_m, best_m in rows:
        dname = (driver_display or "").strip() or None
        st_l = (st or "").lower()
        on_scene = st_l == "on_scene"
        out.append(
            AdminAnalyticsVehiclePerformanceOut(
                vehicle_id=vid,
                label=label,
                driver_name=dname,
                dispatch_count=int(dcount),
                avg_response_minutes=round(float(avg_m), 2) if avg_m is not None else None,
                best_response_minutes=round(float(best_m), 2) if best_m is not None else None,
                status=st,
                on_scene_now=on_scene,
                latitude=float(vlat) if vlat is not None else None,
                longitude=float(vlng) if vlng is not None else None,
            )
        )
    return out


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _eta_minutes_from_distance_m(m: float) -> float:
    if m <= 0:
        return 0.0
    km = m / 1000.0
    return round((km / 40.0) * 60.0, 1)


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
            Incident.status.notin_(list(_ACTIVE_STATUSES_EXCLUDE)),
        )
    ).scalar_one()
    dispatched = db.execute(
        select(func.count()).select_from(Incident).where(
            Incident.status.in_(["dispatched", "en_route", "on_scene", "transporting"]),
        )
    ).scalar_one()
    start_utc = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    closed_today = db.execute(
        select(func.count()).select_from(Incident).where(
            Incident.status.in_(["closed", "archived", "expired", "cancelled", "recalled"]),
            Incident.updated_at >= start_utc,
        )
    ).scalar_one()
    v_count = db.execute(select(func.count()).select_from(Vehicle)).scalar_one()
    c_count = db.execute(select(func.count()).select_from(Corridor)).scalar_one()
    total_all, resolved_closed = db.execute(
        text(
            """
            SELECT COUNT(*)::int,
              COUNT(*) FILTER (WHERE status IN ('closed', 'cleared'))::int
            FROM incidents
            """
        )
    ).one()
    resolution_rate = (
        round(100.0 * int(resolved_closed) / int(total_all), 2) if int(total_all) > 0 else None
    )
    return AdminDashboardOut(
        active_incidents=int(active),
        total_vehicles=int(v_count),
        total_corridors=int(c_count),
        dispatched_incidents=int(dispatched),
        closed_today=int(closed_today),
        resolution_rate=resolution_rate,
    )


@router.get("/audit-log", response_model=list[AuditLogEntryOut])
def list_audit_log(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    rows = db.execute(select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(100)).scalars().all()
    return [AuditLogEntryOut.model_validate(r) for r in rows]


@router.get("/request-logs", response_model=list[ApiRequestLogOut])
def list_request_logs(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
    limit: int = Query(500, ge=1, le=5000),
):
    """HTTP access log for the last 24 hours (admin only)."""
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    rows = db.execute(
        select(ApiRequestLog)
        .where(ApiRequestLog.timestamp >= since)
        .order_by(ApiRequestLog.timestamp.desc())
        .limit(limit)
    ).scalars().all()
    return [ApiRequestLogOut.model_validate(r) for r in rows]


@router.post("/incidents/archive-stale", response_model=AdminArchiveStaleOut)
def admin_archive_stale_incidents(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
    older_than_hours: int = Query(24, ge=1, le=8760),
):
    """Mark incidents older than `older_than_hours` as archived (test-data cleanup).

    Skips rows already archived and incidents currently in active response
    (dispatched / en_route / on_scene) so live dispatches are not torn down.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
    r = db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'archived', updated_at = now()
            WHERE created_at < :cutoff
              AND status != 'archived'
              AND status NOT IN ('dispatched', 'en_route', 'on_scene')
            """
        ),
        {"cutoff": cutoff},
    )
    db.commit()
    sync_vehicle_statuses_with_incidents(db, commit=True)
    return AdminArchiveStaleOut(updated=int(r.rowcount or 0))


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


@router.get("/incidents/active", response_model=list[AdminRecentIncidentItem])
def admin_active_incidents(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
    limit: int = Query(100, ge=1, le=200),
):
    q = (
        select(Incident, Corridor.name)
        .join(Corridor, Incident.corridor_id == Corridor.id)
        .where(Incident.status.notin_(list(_ACTIVE_STATUSES_EXCLUDE)))
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


@router.get("/vehicles", response_model=list[AdminVehicleDashboardOut])
def admin_vehicles_dashboard(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    rows = db.execute(
        select(Vehicle, Corridor.name)
        .join(Corridor, Vehicle.corridor_id == Corridor.id)
        .order_by(Corridor.name, Vehicle.label)
    ).all()
    out: list[AdminVehicleDashboardOut] = []
    for v, corridor_name in rows:
        driver_name: str | None = None
        if v.driver_user_id:
            drv = db.get(User, v.driver_user_id)
            if drv is not None:
                driver_name = (drv.full_name or drv.phone or "").strip() or None
        km_val: float | None = None
        if v.lat is not None and v.lng is not None:
            km_val = round(nh48_km_from_lat_lng(float(v.lat), float(v.lng)), 1)
        out.append(
            AdminVehicleDashboardOut(
                id=v.id,
                label=v.label,
                corridor_name=corridor_name,
                driver_name=driver_name,
                status=v.status,
                is_available=v.is_available,
                km_marker=km_val,
                latitude=float(v.lat) if v.lat is not None else None,
                longitude=float(v.lng) if v.lng is not None else None,
                updated_at=v.updated_at,
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
        select(Dispatch, Vehicle)
        .join(Vehicle, Dispatch.vehicle_id == Vehicle.id)
        .where(Dispatch.incident_id == incident_id)
        .order_by(Dispatch.created_at.desc())
        .limit(1)
    ).first()

    assigned_vehicle_id: uuid.UUID | None = None
    assigned_vehicle_label: str | None = None
    driver_name: str | None = None
    eta_minutes: float | None = None
    if last_dispatch:
        _d, veh = last_dispatch
        assigned_vehicle_id = veh.id
        assigned_vehicle_label = veh.label
        if veh.driver_user_id:
            drv = db.get(User, veh.driver_user_id)
            if drv is not None:
                driver_name = (drv.full_name or drv.phone or "").strip() or None
        ilat, ilng = incident_lat_lng(db, incident)
        if (
            veh.lat is not None
            and veh.lng is not None
            and ilat is not None
            and ilng is not None
        ):
            dist_m = _haversine_m(float(ilat), float(ilng), float(veh.lat), float(veh.lng))
            eta_minutes = _eta_minutes_from_distance_m(dist_m)

    lat_out: float | None
    lng_out: float | None
    ilat, ilng = incident_lat_lng(db, incident)
    lat_out = float(ilat) if ilat is not None else None
    lng_out = float(ilng) if ilng is not None else None

    sos = incident.sos_details
    if isinstance(sos, dict):
        sos_out: dict | None = dict(sos)
    else:
        sos_out = None

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
        latitude=lat_out,
        longitude=lng_out,
        public_report_id=incident.public_report_id,
        created_at=incident.created_at,
        reporter_type=incident.reporter_type,
        injured_count=incident.injured_count,
        notes=incident.notes,
        sos_details=sos_out,
        assigned_vehicle_id=assigned_vehicle_id,
        assigned_vehicle_label=assigned_vehicle_label,
        driver_name=driver_name,
        eta_minutes=eta_minutes,
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
    user: User = Depends(admin_user),
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
        auto_dispatch_enabled=True,
    )
    db.add(corridor)
    db.commit()
    db.refresh(corridor)
    log_audit(
        user=user,
        action="corridor_created",
        entity_type="corridor",
        entity_id=corridor.id,
        details={"name": corridor.name, "source": "admin_ui"},
    )
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
            .where(Incident.status.notin_(["closed", "cancelled", "archived"]))
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
                select(Incident.km_marker, Incident.id, Incident.incident_type)
                .join(Dispatch, Dispatch.incident_id == Incident.id)
                .where(Dispatch.vehicle_id == v.id)
                .order_by(Dispatch.created_at.desc())
                .limit(1)
            ).first()
            last_km = assign_row[0] if assign_row else None
            assign_incident_id = assign_row[1] if assign_row else None
            assign_incident_type = assign_row[2] if assign_row else None
            driver_name: str | None = None
            if v.driver_user_id:
                drv = db.get(User, v.driver_user_id)
                if drv is not None:
                    raw = (drv.full_name or drv.phone or "").strip()
                    driver_name = raw or None
            vehicles.append(
                LiveMapVehicleOut(
                    id=v.id,
                    label=v.label,
                    status=v.status,
                    km_marker=float(last_km) if last_km is not None else None,
                    latitude=float(la) if la is not None else None,
                    longitude=float(ln) if ln is not None else None,
                    assigned_incident_id=assign_incident_id,
                    assigned_incident_type=assign_incident_type,
                    driver_name=driver_name,
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


@router.get("/analytics", response_model=AdminAnalyticsOut)
def admin_analytics(
    period: Literal["today", "7d", "30d"] = Query("7d", description="Time window for analytics"),
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    now = datetime.now(timezone.utc)
    start, end, prev_start, prev_end, comparison_label = _analytics_windows(period, now)

    incidents = _analytics_incident_rows(db, start, end)
    incidents_previous = _analytics_incident_rows(db, prev_start, prev_end)
    incidents_historical = _analytics_incident_rows_historical(db, now)
    fleet = _fleet_breakdown(db)
    coverage = _coverage_stats(db)
    vehicle_performance = _vehicle_performance_for_period(db, start, end)

    return AdminAnalyticsOut(
        period=period,
        comparison_label=comparison_label,
        incidents=incidents,
        incidents_previous=incidents_previous,
        incidents_historical=incidents_historical,
        fleet=fleet,
        coverage=coverage,
        vehicle_performance=vehicle_performance,
    )


@router.post("/broadcast")
async def admin_broadcast(
    body: BroadcastBody,
    db: Session = Depends(get_db),
    user: User = Depends(admin_user),
):
    from app.socket_server import emit_driver_broadcast

    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message is empty")
    row = BroadcastMessage(message=msg, created_by=user.id, priority=body.priority)
    db.add(row)
    db.commit()
    db.refresh(row)
    created = row.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    sender = (user.full_name or user.phone or "Dispatch Control").strip() or "Dispatch Control"
    await emit_driver_broadcast(
        {
            "message": row.message,
            "id": str(row.id),
            "created_at": created.isoformat(),
            "sender_name": sender,
            "priority": row.priority,
        }
    )
    return {"ok": True, "id": str(row.id)}


@router.get("/incidents/export")
def export_incidents_csv(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
    limit: int = Query(100, ge=1, le=500),
):
    rows = db.execute(
        text(
            """
            SELECT
              i.public_report_id,
              i.incident_type,
              i.severity,
              i.km_marker,
              i.status,
              i.trust_score,
              i.created_at,
              fd.dispatched_at,
              v.label,
              EXTRACT(EPOCH FROM (fd.dispatched_at - i.created_at)) / 60.0 AS resp_min
            FROM incidents i
            LEFT JOIN LATERAL (
              SELECT d.created_at AS dispatched_at, d.vehicle_id
              FROM dispatches d
              WHERE d.incident_id = i.id
              ORDER BY d.created_at ASC
              LIMIT 1
            ) fd ON true
            LEFT JOIN vehicles v ON v.id = fd.vehicle_id
            ORDER BY i.created_at DESC
            LIMIT :lim
            """
        ),
        {"lim": limit},
    ).fetchall()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "Report ID",
            "Type",
            "Severity",
            "KM",
            "Status",
            "Trust Score",
            "Reported At",
            "Dispatched At",
            "Vehicle Assigned",
            "Response Time Minutes",
        ]
    )
    for row in rows:
        pr, it, sev, km, st, trust, created, disp_at, vlabel, resp_min = row
        w.writerow(
            [
                pr or "",
                it,
                sev,
                f"{float(km):.1f}" if km is not None else "",
                st,
                trust,
                created.isoformat() if created else "",
                disp_at.isoformat() if disp_at else "",
                vlabel or "",
                f"{float(resp_min):.2f}" if resp_min is not None else "",
            ]
        )

    data = buf.getvalue()
    return Response(
        content=data.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="reach_incidents_export.csv"'},
    )


@router.get("/speed-zones", response_model=list[SpeedZoneOut])
def list_speed_zones(
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
    corridor_id: uuid.UUID | None = None,
):
    q = select(SpeedZone).order_by(SpeedZone.corridor_id, SpeedZone.start_km)
    if corridor_id is not None:
        q = q.where(SpeedZone.corridor_id == corridor_id)
    rows = db.execute(q).scalars().all()
    return [SpeedZoneOut.model_validate(r) for r in rows]


@router.post("/speed-zones", response_model=SpeedZoneOut)
def create_speed_zone(
    body: SpeedZoneCreateBody,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    if body.end_km <= body.start_km:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_km must be greater than start_km")
    if not db.get(Corridor, body.corridor_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Corridor not found")
    z = SpeedZone(
        corridor_id=body.corridor_id,
        start_km=body.start_km,
        end_km=body.end_km,
        speed_limit_kph=body.speed_limit_kph,
    )
    db.add(z)
    db.commit()
    db.refresh(z)
    return SpeedZoneOut.model_validate(z)


@router.patch("/speed-zones/{zone_id}", response_model=SpeedZoneOut)
def patch_speed_zone(
    zone_id: uuid.UUID,
    body: SpeedZonePatchBody,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    z = db.get(SpeedZone, zone_id)
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Zone not found")
    if body.start_km is not None:
        z.start_km = body.start_km
    if body.end_km is not None:
        z.end_km = body.end_km
    if body.speed_limit_kph is not None:
        z.speed_limit_kph = body.speed_limit_kph
    if z.end_km <= z.start_km:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_km must be greater than start_km")
    db.commit()
    db.refresh(z)
    return SpeedZoneOut.model_validate(z)


@router.delete("/speed-zones/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_speed_zone(
    zone_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(admin_user),
):
    z = db.get(SpeedZone, zone_id)
    if not z:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Zone not found")
    db.delete(z)
    db.commit()
    return None
