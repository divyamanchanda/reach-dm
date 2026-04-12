import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


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


class PublicIncidentCreate(BaseModel):
    incident_type: str
    severity: str
    injured_count: int = 0
    latitude: float | None = None
    longitude: float | None = None
    km_marker: float | None = None
    photo_url: str | None = None
    notes: str | None = None


class PublicIncidentResponse(BaseModel):
    incident_id: uuid.UUID
    public_report_id: str
    trust_score: int
    trust_recommendation: str | None
    nearest_ambulance_eta_minutes: float | None


class VehicleMapOut(BaseModel):
    id: uuid.UUID
    label: str
    vehicle_type: str
    status: str
    is_available: bool
    latitude: float | None
    longitude: float | None
    updated_at: datetime


class AdminDashboardOut(BaseModel):
    active_incidents: int
    total_vehicles: int
    total_corridors: int


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
    public_report_id: str | None
    created_at: datetime
    assigned_vehicle_label: str | None
    timeline: list[TimelineEventOut]


class BroadcastBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


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


class AdminAnalyticsOut(BaseModel):
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
