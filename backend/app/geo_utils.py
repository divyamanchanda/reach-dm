from sqlalchemy import cast, func, select
from sqlalchemy.orm import Session
from geoalchemy2 import Geometry

from app.models import Incident, Vehicle


def point_lat_lng_expr(column):
    """ST_Y/ST_X from geography column."""
    geom = cast(column, Geometry(geometry_type="POINT", srid=4326))
    return func.ST_Y(geom), func.ST_X(geom)


def incident_lat_lng(db: Session, incident: Incident) -> tuple[float | None, float | None]:
    if incident.location is None:
        return None, None
    lat_e, lng_e = point_lat_lng_expr(Incident.location)
    row = db.execute(select(lat_e, lng_e).where(Incident.id == incident.id)).one()
    return (float(row[0]) if row[0] is not None else None, float(row[1]) if row[1] is not None else None)


def vehicle_lat_lng_row(db: Session, vehicle_id) -> tuple[float | None, float | None]:
    lat_e, lng_e = point_lat_lng_expr(Vehicle.location)
    row = db.execute(select(lat_e, lng_e).where(Vehicle.id == vehicle_id)).one_or_none()
    if not row or row[0] is None:
        return None, None
    return float(row[0]), float(row[1])
