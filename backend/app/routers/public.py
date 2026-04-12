from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.corridor_public import list_active_corridors_for_public
from app.database import get_db
from app.schemas import CorridorPublicOut

router = APIRouter(prefix="/public", tags=["public"])

_ALLOWED_IMAGE_CT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_MAX_BYTES = 5 * 1024 * 1024
_SAFE_FILE = re.compile(r"^[a-f0-9]{32}\.(jpg|png|webp|gif)$", re.IGNORECASE)


@router.get("/corridors", response_model=list[CorridorPublicOut])
def get_public_corridor_names(db: Session = Depends(get_db)):
    """Active corridors for public emergency reporting (no auth)."""
    return list_active_corridors_for_public(db)


@router.post("/upload")
async def upload_public_photo(request: Request, file: UploadFile = File(...)):
    """Upload a scene photo for public SOS; returns absolute photo_url for the incident payload."""
    raw_ct = (file.content_type or "").split(";")[0].strip().lower()
    ext = _ALLOWED_IMAGE_CT.get(raw_ct)
    if not ext:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only JPEG, PNG, WebP, or GIF images are allowed",
        )
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image too large (max 5MB)")
    if len(data) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")

    upload_root = Path(settings.public_upload_dir)
    upload_root.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    path = upload_root / name
    path.write_bytes(data)

    base = str(request.base_url).rstrip("/")
    prefix = settings.api_prefix.rstrip("/") or "/api"
    photo_url = f"{base}{prefix}/public/files/{name}"
    return {"photo_url": photo_url}


@router.get("/files/{filename}")
def get_public_file(filename: str):
    if not _SAFE_FILE.match(filename):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    path = Path(settings.public_upload_dir) / filename
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return FileResponse(path)
