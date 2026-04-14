from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Corridor

_HINT_RE = re.compile(r"\bNH\s*-?\s*(\d{1,4})\b", re.IGNORECASE)
_EARTH_M = 6_371_000.0


@dataclass
class CorridorDetectResult:
    corridor_id: uuid.UUID
    corridor_name: str
    confidence: float
    method: str


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_M * math.asin(min(1.0, math.sqrt(a)))


def _point_segment_distance_m(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    # Local equirectangular projection around p for stable small-distance computation.
    lat0 = math.radians(px)
    cos0 = max(1e-6, math.cos(lat0))
    sx, sy = py * cos0, px
    x1, y1 = ay * cos0, ax
    x2, y2 = by * cos0, bx
    dx, dy = x2 - x1, y2 - y1
    den = dx * dx + dy * dy
    if den <= 1e-12:
        return _haversine_m(px, py, ax, ay)
    t = ((sx - x1) * dx + (sy - y1) * dy) / den
    t = max(0.0, min(1.0, t))
    qx, qy = x1 + t * dx, y1 + t * dy
    qlat, qlng = qy, qx / cos0
    return _haversine_m(px, py, qlat, qlng)


def _normalized_hint_tokens(hint: str | None) -> list[str]:
    if not hint:
        return []
    text = hint.strip().upper()
    if not text:
        return []
    out: list[str] = []
    for m in _HINT_RE.finditer(text):
        out.append(f"NH{m.group(1)}")
    if text.startswith("NH") and text not in out:
        out.append(text.replace(" ", "").replace("-", ""))
    return sorted(set(out))


def _corridor_points(c: Corridor) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    if isinstance(c.waypoints, list):
        for row in c.waypoints:
            if not isinstance(row, dict):
                continue
            lat = row.get("lat")
            lng = row.get("lng")
            if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
                pts.append((float(lat), float(lng)))
    if len(pts) >= 2:
        return pts
    if c.start_lat is not None and c.start_lng is not None:
        pts.append((float(c.start_lat), float(c.start_lng)))
    if c.end_lat is not None and c.end_lng is not None:
        pts.append((float(c.end_lat), float(c.end_lng)))
    return pts


def _filter_by_hint(corridors: list[Corridor], highway_hint: str | None) -> list[Corridor]:
    tokens = _normalized_hint_tokens(highway_hint)
    if not tokens:
        return corridors
    out: list[Corridor] = []
    for c in corridors:
        hay = f"{(c.code or '').upper()} {(c.name or '').upper()}".replace(" ", "").replace("-", "")
        if any(tok in hay for tok in tokens):
            out.append(c)
    return out or corridors


def _confidence_from_distance_m(dist_m: float) -> float:
    if dist_m <= 120:
        return 0.99
    if dist_m <= 500:
        return 0.93
    if dist_m <= 2_000:
        return 0.78
    if dist_m <= 8_000:
        return 0.62
    return max(0.35, min(0.58, 1.0 - (dist_m / 50_000.0)))


def detect_corridor(
    db: Session,
    *,
    lat: float | None = None,
    lng: float | None = None,
    km_marker: float | None = None,
    highway_hint: str | None = None,
) -> CorridorDetectResult | None:
    rows = list(db.execute(select(Corridor).where(Corridor.is_active.is_(True)).order_by(Corridor.name)).scalars().all())
    if not rows:
        return None
    rows = _filter_by_hint(rows, highway_hint)

    if lat is not None and lng is not None:
        best: tuple[Corridor, float] | None = None
        for c in rows:
            pts = _corridor_points(c)
            if len(pts) < 2:
                continue
            d = min(
                _point_segment_distance_m(lat, lng, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
                for i in range(len(pts) - 1)
            )
            if best is None or d < best[1]:
                best = (c, d)
        if best:
            c, dist_m = best
            return CorridorDetectResult(
                corridor_id=c.id,
                corridor_name=c.name,
                confidence=round(_confidence_from_distance_m(dist_m), 3),
                method="gps_polyline",
            )

    if km_marker is not None:
        matches = corridors_for_km(rows, float(km_marker))
        if matches:
            chosen = matches[0]
            confidence = 0.95 if len(matches) == 1 else 0.72
            return CorridorDetectResult(
                corridor_id=chosen.id,
                corridor_name=chosen.name,
                confidence=confidence,
                method="km_range",
            )
    return None


def corridors_for_km(corridors: list[Corridor], km_marker: float) -> list[Corridor]:
    km = float(km_marker)
    return [
        c
        for c in corridors
        if c.km_start is not None and c.km_end is not None and float(c.km_start) <= km <= float(c.km_end)
    ]


def active_corridors_filtered(db: Session, highway_hint: str | None = None) -> list[Corridor]:
    rows = list(db.execute(select(Corridor).where(Corridor.is_active.is_(True)).order_by(Corridor.name)).scalars().all())
    return _filter_by_hint(rows, highway_hint)
