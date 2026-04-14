from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import CorridorDetectRequest, CorridorDetectResponse
from app.services.corridor_detection import active_corridors_filtered, corridors_for_km, detect_corridor

router = APIRouter(prefix="/corridor", tags=["corridor-detect"])


@router.post("/detect", response_model=CorridorDetectResponse)
def detect_corridor_endpoint(
    body: CorridorDetectRequest,
    db: Session = Depends(get_db),
):
    has_gps = body.lat is not None and body.lng is not None
    has_km = body.km_marker is not None
    if not has_gps and not has_km:
        raise HTTPException(status_code=400, detail="Provide lat/lng or km_marker")
    km_matches: list[dict] = []
    if body.km_marker is not None:
        pool = active_corridors_filtered(db, body.highway_hint)
        km_rows = corridors_for_km(pool, body.km_marker)
        km_matches = [{"corridor_id": c.id, "corridor_name": c.name} for c in km_rows]
    det = detect_corridor(
        db,
        lat=body.lat,
        lng=body.lng,
        km_marker=body.km_marker,
        highway_hint=body.highway_hint,
    )
    if det is None:
        raise HTTPException(status_code=404, detail="No matching corridor found")
    return CorridorDetectResponse(
        corridor_id=det.corridor_id,
        corridor_name=det.corridor_name,
        confidence=det.confidence,
        method=det.method,
        matches=km_matches,
    )
