"""
Trust score 0–100 and dispatch recommendation (product brief).
Simplified: corroboration / FASTag / toll anomalies not implemented — hooks left as factors when added.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass
class TrustResult:
    score: int
    recommendation: str
    factors: list[dict[str, Any]]


def _clamp(n: int) -> int:
    return max(0, min(100, n))


def recommendation_for_score(score: int) -> str:
    return "dispatch_both"


def compute_trust_public_sos(
    *,
    has_gps: bool,
    has_photo: bool,
    corroboration_count: int,
    is_sms: bool = False,
) -> TrustResult:
    score = 0
    factors: list[dict[str, Any]] = []

    if is_sms:
        score += 10
        factors.append({"factor": "sms_report", "weight": 10, "note": "SMS channel"})
    elif has_gps:
        score += 30
        factors.append({"factor": "public_sos_gps", "weight": 30})
    else:
        score += 15
        factors.append({"factor": "public_sos_no_gps", "weight": 15})

    if has_photo:
        score += 15
        factors.append({"factor": "photo_uploaded", "weight": 15})

    if corroboration_count >= 2:
        score += 20
        factors.append({"factor": "multiple_reports", "weight": 20, "count": corroboration_count})
    elif corroboration_count <= 1:
        score -= 10
        factors.append({"factor": "single_report", "weight": -10})

    if not has_gps:
        score -= 15
        factors.append({"factor": "no_gps_deduction", "weight": -15})
    # Note: public_sos_no_gps path already reflects low GPS trust; deduction matches brief "No GPS location −15".

    score = _clamp(score)
    return TrustResult(score=score, recommendation=recommendation_for_score(score), factors=factors)


def count_nearby_reports(
    db: Session,
    corridor_id,
    lat: float | None,
    lng: float | None,
    radius_m: float = 500.0,
) -> int:
    """Approximate corroboration: incidents on same corridor within radius (needs point)."""
    if lat is None or lng is None:
        return 1
    row = db.execute(
        text(
            """
            SELECT COUNT(*) FROM incidents
            WHERE corridor_id = :cid
              AND lat IS NOT NULL AND lng IS NOT NULL
              AND (
                6371000 * acos(
                  least(1::double precision, greatest(-1::double precision,
                    cos(radians(:lat)) * cos(radians(lat)) * cos(radians(lng) - radians(:lng))
                    + sin(radians(:lat)) * sin(radians(lat))
                  ))
                )
              ) <= :radius
            """
        ),
        {"cid": str(corridor_id), "lng": lng, "lat": lat, "radius": radius_m},
    ).scalar_one()
    return int(row)
