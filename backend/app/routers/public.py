from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.corridor_public import list_active_corridors_for_public
from app.database import get_db
from app.schemas import CorridorPublicOut

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/corridors", response_model=list[CorridorPublicOut])
def get_public_corridor_names(db: Session = Depends(get_db)):
    """Active corridors for public emergency reporting (no auth)."""
    return list_active_corridors_for_public(db)
