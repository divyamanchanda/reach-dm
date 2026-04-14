import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class LoginRequest(BaseModel):
    phone: str = Field(..., min_length=5, max_length=32)
    password: str = Field(..., min_length=1)


class UserPublic(BaseModel):
    id: uuid.UUID
    phone: str
    full_name: str | None
    role: str
    organisation_id: uuid.UUID | None

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class CorridorPublicOut(BaseModel):
    """Minimal corridor info for public SOS highway picker (no auth)."""

    id: uuid.UUID
    name: str


class CorridorOut(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None
    start_lat: float | None = None
    start_lng: float | None = None
    end_lat: float | None = None
    end_lng: float | None = None
    waypoints: list[dict] | None = None
    km_start: float | None
    km_end: float | None
    is_active: bool

    model_config = {"from_attributes": True}


class CorridorStatsOut(BaseModel):
    active_incidents: int
    pending_dispatch: int
    available_vehicles: int
    avg_response_time_minutes: float | None


class IncidentListItem(BaseModel):
    id: uuid.UUID
    corridor_id: uuid.UUID
    incident_type: str
    severity: str
    km_marker: float | None
    latitude: float | None
    longitude: float | None
    trust_score: int
    trust_recommendation: str | None
    trust_factors: list = Field(default_factory=list)
    status: str
    reporter_type: str
    injured_count: int
    notes: str | None = None
    public_report_id: str | None = None
    created_at: datetime
    updated_at: datetime
    eligible_for_reassign: bool = False


class IncidentPatchBody(BaseModel):
    """Partial update for dispatch console (e.g. operator notes)."""

    notes: str | None = None


class TimelineEventOut(BaseModel):
    id: uuid.UUID
    event_type: str
    payload: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class IncidentDetailOut(BaseModel):
    id: uuid.UUID
    corridor_id: uuid.UUID
    incident_type: str
    severity: str
    km_marker: float | None
    latitude: float | None
    longitude: float | None
    trust_score: int
    trust_recommendation: str | None
    trust_factors: list
    status: str
    reporter_type: str
    injured_count: int
    notes: str | None
    photo_url: str | None
    public_report_id: str | None
    created_at: datetime
    updated_at: datetime
    timeline: list[TimelineEventOut]


class NearbyVehicleOut(BaseModel):
    vehicle_id: uuid.UUID
    label: str
    status: str
    distance_meters: float
    eta_minutes: float | None
    eta_source: str


class VehicleMineOut(BaseModel):
    """Vehicle tied to the logged-in driver (App3)."""

    id: uuid.UUID
    corridor_id: uuid.UUID
    corridor_name: str
    label: str
    status: str
    vehicle_type: str


class VehicleIncidentHistoryItem(BaseModel):
    """Incidents this vehicle was dispatched to (App3 history list)."""

    id: uuid.UUID
    incident_type: str
    status: str
    created_at: datetime


class DispatchBody(BaseModel):
    vehicle_id: uuid.UUID


class IncidentStatusBody(BaseModel):
    status: str


class IncidentVerifyBody(BaseModel):
    trust_score: int = Field(80, ge=0, le=100)
    status: str = "confirmed_real"


class VehicleLocationBody(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)


class VehicleStatusBody(BaseModel):
    status: str


_HAZARD_IDS = frozenset({"fire_smoke", "fuel_spill", "live_wire", "lane_blocked", "none_visible"})


class PublicIncidentCreate(BaseModel):
    corridor_id: uuid.UUID | None = None
    incident_type: str
    severity: str
    injured_count: int = 0
    latitude: float | None = None
    longitude: float | None = None
    km_marker: float | None = None
    photo_url: str | None = None
    notes: str | None = None
    highway_hint: str | None = None
    direction: str | None = None
    hazards: list[str] = Field(default_factory=list)
    vehicles_involved: int = Field(1, ge=0, le=99)

    @field_validator("direction", mode="before")
    @classmethod
    def normalize_direction(cls, v: object) -> str | None:
        if v is None or v == "":
            return None
        s = str(v).strip()
        if s in ("towards_chennai", "towards_bengaluru"):
            return s
        raise ValueError("direction must be towards_chennai or towards_bengaluru")

    @field_validator("hazards", mode="after")
    @classmethod
    def normalize_hazards(cls, v: list[str]) -> list[str]:
        out = [h for h in v if h in _HAZARD_IDS]
        if "none_visible" in out and len(out) > 1:
            out = [h for h in out if h != "none_visible"]
        return sorted(set(out))


class PublicIncidentResponse(BaseModel):
    incident_id: uuid.UUID
    public_report_id: str
    trust_score: int
    trust_recommendation: str | None
    nearest_ambulance_eta_minutes: float | None


class CorridorDetectRequest(BaseModel):
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    km_marker: float | None = None
    highway_hint: str | None = None

    @field_validator("highway_hint", mode="before")
    @classmethod
    def normalize_hint(cls, v: object) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        return s or None


class CorridorDetectResponse(BaseModel):
    corridor_id: uuid.UUID
    corridor_name: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    method: Literal["gps_polyline", "km_range"]
    matches: list[dict] = Field(default_factory=list)


class VehicleMapOut(BaseModel):
    id: uuid.UUID
    label: str
    vehicle_type: str
    status: str
    is_available: bool
    latitude: float | None
    longitude: float | None
    updated_at: datetime
    driver_phone: str | None = None


class AdminDashboardOut(BaseModel):
    active_incidents: int
    total_vehicles: int
    total_corridors: int
    dispatched_incidents: int
    closed_today: int


class AdminArchiveStaleOut(BaseModel):
    """Bulk archive for admin test-data cleanup."""

    updated: int


class AdminRecentIncidentItem(BaseModel):
    id: uuid.UUID
    corridor_id: uuid.UUID
    corridor_name: str
    incident_type: str
    severity: str
    status: str
    km_marker: float | None
    created_at: datetime


class AdminUserCreateBody(BaseModel):
    phone: str = Field(..., min_length=5, max_length=32)
    password: str = Field(..., min_length=1)
    full_name: str | None = None
    role: Literal["dispatch_operator", "driver", "admin"]
    organisation_id: uuid.UUID | None = None


class AdminCorridorCreateBody(BaseModel):
    name: str = Field(..., min_length=1)
    code: str | None = None
    start_lat: float = Field(..., ge=-90, le=90)
    start_lng: float = Field(..., ge=-180, le=180)
    end_lat: float = Field(..., ge=-90, le=90)
    end_lng: float = Field(..., ge=-180, le=180)
    km_length: float = Field(..., gt=0)
    organisation_id: uuid.UUID | None = None


class OrganisationMiniOut(BaseModel):
    id: uuid.UUID
    name: str

    model_config = {"from_attributes": True}


class LiveMapIncidentOut(BaseModel):
    id: uuid.UUID
    incident_type: str
    severity: str
    trust_score: int
    km_marker: float | None
    status: str
    created_at: datetime
    latitude: float | None
    longitude: float | None
    public_report_id: str | None = None


class LiveMapVehicleOut(BaseModel):
    id: uuid.UUID
    label: str
    status: str
    km_marker: float | None
    latitude: float | None
    longitude: float | None
    assigned_incident_id: uuid.UUID | None = None
    assigned_incident_type: str | None = None
    driver_name: str | None = None


class LiveMapCorridorOut(BaseModel):
    id: uuid.UUID
    name: str
    km_start: float | None
    km_end: float | None
    incidents: list[LiveMapIncidentOut]
    vehicles: list[LiveMapVehicleOut]


class LiveMapOut(BaseModel):
    corridors: list[LiveMapCorridorOut]


class AdminIncidentDetailOut(BaseModel):
    id: uuid.UUID
    incident_type: str
    severity: str
    status: str
    trust_score: int
    km_marker: float | None
    latitude: float | None
    longitude: float | None
    public_report_id: str | None
    created_at: datetime
    reporter_type: str
    injured_count: int
    notes: str | None
    sos_details: dict | None
    assigned_vehicle_id: uuid.UUID | None
    assigned_vehicle_label: str | None
    driver_name: str | None
    eta_minutes: float | None
    timeline: list[TimelineEventOut]


class AdminVehicleDashboardOut(BaseModel):
    id: uuid.UUID
    label: str
    corridor_name: str
    driver_name: str | None
    status: str
    is_available: bool
    km_marker: float | None
    latitude: float | None
    longitude: float | None
    updated_at: datetime


class BroadcastBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    priority: Literal["urgent", "info"] | None = Field(
        default=None,
        description="Optional priority for driver notification (urgent vs info).",
    )


class AnalyticsResponsePointOut(BaseModel):
    incident_id: uuid.UUID
    reported_at: datetime
    response_minutes: float


class AnalyticsHeatmapBucketOut(BaseModel):
    segment_start_km: float
    incident_count: int


class AnalyticsVehicleDispatchOut(BaseModel):
    vehicle_label: str
    dispatch_count: int


class AnalyticsActiveDriverOut(BaseModel):
    driver_name: str
    phone: str
    vehicle_label: str
    vehicle_status: str
    last_gps_at: datetime | None
    on_active_call: bool


class AnalyticsKpiTrendOut(BaseModel):
    arrow: Literal["up", "down", "flat"]
    favorable: bool


class AdminAnalyticsKpisOut(BaseModel):
    total_incidents: int
    total_incidents_delta: int
    total_incidents_trend: AnalyticsKpiTrendOut

    avg_response_time_minutes: float | None
    avg_response_time_prev_minutes: float | None
    response_time_under_target: bool
    avg_response_time_trend: AnalyticsKpiTrendOut

    resolution_rate_pct: float | None
    resolution_rate_prev_pct: float | None
    resolution_rate_trend: AnalyticsKpiTrendOut

    hoax_rate_pct: float | None
    hoax_rate_prev_pct: float | None
    hoax_rate_trend: AnalyticsKpiTrendOut

    ambulances_on_duty: int
    ambulances_total: int
    ambulances_trend: AnalyticsKpiTrendOut

    sos_app: int
    sos_sms: int
    sos_auto: int
    sos_source_trend: AnalyticsKpiTrendOut


class AdminAnalyticsOut(BaseModel):
    period: str
    comparison_label: str
    kpis: AdminAnalyticsKpisOut
    avg_response_time_minutes: float | None
    response_time_last_20: list[AnalyticsResponsePointOut]
    heatmap_buckets: list[AnalyticsHeatmapBucketOut]
    vehicle_dispatch_counts: list[AnalyticsVehicleDispatchOut]
    active_drivers: list[AnalyticsActiveDriverOut]


class SpeedZoneOut(BaseModel):
    id: uuid.UUID
    corridor_id: uuid.UUID
    start_km: float
    end_km: float
    speed_limit_kph: float
    created_at: datetime

    model_config = {"from_attributes": True}


class SpeedZoneCreateBody(BaseModel):
    corridor_id: uuid.UUID
    start_km: float = Field(..., ge=0)
    end_km: float = Field(..., ge=0)
    speed_limit_kph: float = Field(100, gt=0, le=200)


class SpeedZonePatchBody(BaseModel):
    start_km: float | None = Field(None, ge=0)
    end_km: float | None = Field(None, ge=0)
    speed_limit_kph: float | None = Field(None, gt=0, le=200)


class SmsTestBody(BaseModel):
    """Manual test payload for inbound SMS handling."""

    message: str = Field(..., min_length=1)
    from_: str = Field(..., min_length=5, alias="from", description="Sender phone (E.164 recommended)")

    model_config = {"populate_by_name": True}


class SmsIncomingResponse(BaseModel):
    incident_id: uuid.UUID
    corridor_id: uuid.UUID
    public_report_id: str
    reply_text: str
    reply_sent: bool
