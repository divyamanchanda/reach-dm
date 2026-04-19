from __future__ import annotations

import logging
import uuid
from typing import Any

from app.database import SessionLocal
from app.models import AuditLog, User

logger = logging.getLogger(__name__)


def log_audit(
    *,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None = None,
    details: dict[str, Any] | None = None,
    user: User | None = None,
    user_id: uuid.UUID | None = None,
    user_name: str | None = None,
) -> None:
    """Append an audit row in its own session (best-effort; failures are logged only)."""
    uid = user_id
    uname = user_name
    if user is not None:
        uid = user.id
        uname = (user.full_name or "").strip() or user.phone
    db = SessionLocal()
    try:
        db.add(
            AuditLog(
                user_id=uid,
                user_name=uname,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                details=details,
            )
        )
        db.commit()
    except Exception:
        logger.exception("audit log insert failed action=%s", action)
        db.rollback()
    finally:
        db.close()
