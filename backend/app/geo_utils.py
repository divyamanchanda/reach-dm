"""Lat/lng stored as plain FLOAT columns (no PostGIS)."""

from sqlalchemy.orm import Session

from app.models import Incident

NH48_KM_LENGTH = 312.0
_BENGALURU = (12.9716, 77.5946)
_CHENNAI = (13.0827, 80.2707)


def nh48_lat_lng_from_km(km: float) -> tuple[float, float]:
    """Linear interpolation along Bengaluru–Chennai segment (demo NH48 axis)."""
    t = max(0.0, min(1.0, km / NH48_KM_LENGTH))
    lat = _BENGALURU[0] + (_CHENNAI[0] - _BENGALURU[0]) * t
    lng = _BENGALURU[1] + (_CHENNAI[1] - _BENGALURU[1]) * t
    return lat, lng


def nh48_km_from_lat_lng(lat: float, lng: float) -> float:
    """Project point onto Bengaluru–Chennai segment; return km 0–N."""
    b_lat, b_lng = _BENGALURU
    c_lat, c_lng = _CHENNAI
    dx = c_lng - b_lng
    dy = c_lat - b_lat
    len2 = dx * dx + dy * dy
    if len2 <= 0:
        return 0.0
    t = max(0.0, min(1.0, ((lng - b_lng) * dx + (lat - b_lat) * dy) / len2))
    return t * NH48_KM_LENGTH


def incident_lat_lng(_db: Session, incident: Incident) -> tuple[float | None, float | None]:
    if incident.lat is not None and incident.lng is not None:
        return float(incident.lat), float(incident.lng)
    if incident.km_marker is not None:
        la, ln = nh48_lat_lng_from_km(float(incident.km_marker))
        return la, ln
    return None, None
