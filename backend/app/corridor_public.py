"""Shared query for anonymous highway picker (public SOS)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Corridor
from app.schemas import CorridorPublicOut


def list_active_corridors_for_public(db: Session) -> list[CorridorPublicOut]:
    q = select(Corridor).where(Corridor.is_active.is_(True)).order_by(Corridor.name)
    rows = db.execute(q).scalars().all()
    return [CorridorPublicOut(id=r.id, name=r.name) for r in rows]
