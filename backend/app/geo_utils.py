"""Lat/lng stored as plain FLOAT columns (no PostGIS).

NH48 geometry matches the multi-waypoint polyline used in app4/app1 (nh48Route).
"""

from __future__ import annotations

import math
from sqlalchemy.orm import Session

from app.models import Incident

NH48_KM_LENGTH = 312.0

# Bengaluru → Chennai via Electronic City, Hosur, Krishnagiri, Ambur, Vellore, Ranipet, Sriperumbudur
NH48_WAYPOINTS: list[tuple[float, float]] = [
    (12.9716, 77.5946),
    (12.8458, 77.6692),
    (12.7409, 77.8253),
    (12.5266, 78.2137),
    (12.7833, 78.7167),
    (12.9165, 79.1325),
    (12.9224, 79.3327),
    (12.9674, 79.9475),
    (13.0827, 80.2707),
]


def _haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def _cumulative_km(route: list[tuple[float, float]]) -> list[float]:
    acc: list[float] = [0.0]
    for i in range(1, len(route)):
        a = route[i - 1]
        b = route[i]
        acc.append(acc[i - 1] + _haversine_km(a[0], a[1], b[0], b[1]))
    return acc


_CUM_CACHE: list[float] | None = None


def _nh48_cum() -> list[float]:
    global _CUM_CACHE
    if _CUM_CACHE is None:
        _CUM_CACHE = _cumulative_km(NH48_WAYPOINTS)
    return _CUM_CACHE


def nh48_total_route_km() -> float:
    c = _nh48_cum()
    return c[-1] if c else 0.0


def _position_at_distance_km(route: list[tuple[float, float]], cum: list[float], d: float) -> tuple[float, float]:
    if not route:
        raise ValueError("empty route")
    if len(route) == 1:
        return route[0]
    max_d = cum[-1]
    if d <= 0:
        return route[0]
    if d >= max_d:
        return route[-1]
    for i in range(len(route) - 1):
        if d <= cum[i + 1] + 1e-9:
            seg_start = cum[i]
            seg_len = cum[i + 1] - seg_start
            t = (d - seg_start) / seg_len if seg_len > 1e-12 else 0.0
            u = max(0.0, min(1.0, t))
            a_lat, a_lng = route[i]
            b_lat, b_lng = route[i + 1]
            return (
                a_lat + (b_lat - a_lat) * u,
                a_lng + (b_lng - a_lng) * u,
            )
    return route[-1]


def nh48_lat_lng_from_km(km: float) -> tuple[float, float]:
    """Point on NH48 polyline for official km 0–312 (proportional to arc length)."""
    k = max(0.0, min(NH48_KM_LENGTH, float(km)))
    cum = _nh48_cum()
    total = cum[-1]
    if total <= 0:
        return NH48_WAYPOINTS[0]
    d = (k / NH48_KM_LENGTH) * total
    return _position_at_distance_km(NH48_WAYPOINTS, cum, d)


def _closest_point_on_segment(
    p_lat: float, p_lng: float, a: tuple[float, float], b: tuple[float, float]
) -> tuple[float, float]:
    a_lat, a_lng = a
    b_lat, b_lng = b
    dx = b_lng - a_lng
    dy = b_lat - a_lat
    len2 = dx * dx + dy * dy
    if len2 < 1e-18:
        return a_lat, a_lng
    t = ((p_lng - a_lng) * dx + (p_lat - a_lat) * dy) / len2
    t = max(0.0, min(1.0, t))
    return a_lat + t * dy, a_lng + t * dx


def snap_gps_to_nh48_polyline(lat: float, lng: float) -> tuple[float, float]:
    """Closest point on the NH48 waypoint polyline (planar lat/lng segments)."""
    best = (lat, lng)
    best_d = float("inf")
    for i in range(len(NH48_WAYPOINTS) - 1):
        c = _closest_point_on_segment(lat, lng, NH48_WAYPOINTS[i], NH48_WAYPOINTS[i + 1])
        dlat = lat - c[0]
        dlng = lng - c[1]
        d = dlat * dlat + dlng * dlng
        if d < best_d:
            best_d = d
            best = c
    return best


def _distance_along_polyline_km(snap_lat: float, snap_lng: float) -> float:
    """Arc length from route start to `snap` (point on or nearest segment)."""
    cum = _nh48_cum()
    best_along = 0.0
    best_d = float("inf")
    for i in range(len(NH48_WAYPOINTS) - 1):
        a = NH48_WAYPOINTS[i]
        b = NH48_WAYPOINTS[i + 1]
        c_lat, c_lng = _closest_point_on_segment(snap_lat, snap_lng, a, b)
        d = _haversine_km(snap_lat, snap_lng, c_lat, c_lng)
        dx = b[1] - a[1]
        dy = b[0] - a[0]
        len2 = dx * dx + dy * dy
        t = ((c_lng - a[1]) * dx + (c_lat - a[0]) * dy) / len2 if len2 > 1e-18 else 0.0
        u = max(0.0, min(1.0, t))
        seg_len = _haversine_km(a[0], a[1], b[0], b[1])
        along = cum[i] + u * seg_len
        if d < best_d:
            best_d = d
            best_along = along
    return best_along


def nh48_km_from_lat_lng(lat: float, lng: float) -> float:
    """Official km 0–312 for a GPS point (snap to polyline, then arc-length fraction)."""
    slat, slng = snap_gps_to_nh48_polyline(lat, lng)
    along = _distance_along_polyline_km(slat, slng)
    total = nh48_total_route_km()
    if total <= 0:
        return 0.0
    return max(0.0, min(NH48_KM_LENGTH, (along / total) * NH48_KM_LENGTH))


def incident_lat_lng(_db: Session, incident: Incident) -> tuple[float | None, float | None]:
    if incident.lat is not None and incident.lng is not None:
        return float(incident.lat), float(incident.lng)
    if incident.km_marker is not None:
        la, ln = nh48_lat_lng_from_km(float(incident.km_marker))
        return la, ln
    return None, None
