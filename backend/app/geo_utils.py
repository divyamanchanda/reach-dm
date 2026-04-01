"""Lat/lng stored as plain FLOAT columns (no PostGIS)."""

from sqlalchemy.orm import Session

from app.models import Incident


def incident_lat_lng(_db: Session, incident: Incident) -> tuple[float | None, float | None]:
    if incident.lat is None or incident.lng is None:
        return None, None
    return float(incident.lat), float(incident.lng)
