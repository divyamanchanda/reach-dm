"""Socket.IO server (shared process). Rooms: corridor:<uuid>."""

from __future__ import annotations

import uuid

import jwt
import socketio
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import User
from app.security import ALGORITHM

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=settings.cors_origins,
    logger=False,
    engineio_logger=False,
)


def _user_from_token(token: str) -> User | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
        uid = uuid.UUID(payload["sub"])
    except Exception:
        return None
    db = SessionLocal()
    try:
        return db.get(User, uid)
    finally:
        db.close()


@sio.event
async def connect(sid, environ, auth):
    if not auth or not auth.get("token"):
        return False
    user = _user_from_token(auth["token"])
    if not user:
        return False
    await sio.save_session(sid, {"user_id": str(user.id), "role": user.role})
    return True


@sio.event
async def disconnect(sid):
    pass


@sio.on("subscribe_corridor")
async def subscribe_corridor(sid, data):
    if not data or not data.get("corridor_id"):
        return
    session = await sio.get_session(sid)
    if not session:
        return
    cid = data["corridor_id"]
    room = f"corridor:{cid}"
    await sio.enter_room(sid, room)


@sio.on("unsubscribe_corridor")
async def unsubscribe_corridor(sid, data):
    if not data or not data.get("corridor_id"):
        return
    room = f"corridor:{data['corridor_id']}"
    await sio.leave_room(sid, room)


async def emit_to_corridor(event: str, corridor_id: uuid.UUID, payload: dict) -> None:
    await sio.emit(event, payload, room=f"corridor:{corridor_id}")
