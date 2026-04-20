"""CORS-adjacent: rate limiting and API request logging."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from app.database import SessionLocal
from app.models import ApiRequestLog
from app.rate_limiter import ip_rate_limiter

logger = logging.getLogger(__name__)


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    if request.client:
        return request.client.host or "unknown"
    return "unknown"


def _is_sos_post(request: Request) -> bool:
    if request.method != "POST":
        return False
    path = request.url.path.rstrip("/")
    if path.endswith("/incidents/public"):
        return True
    if path.endswith("/sms/incoming") or path.endswith("/sms/test"):
        return True
    return False


def _exempt_from_general_limit(request: Request, api_prefix: str) -> bool:
    if request.method == "OPTIONS":
        return True
    health_path = f"{api_prefix.rstrip('/')}/health"
    if request.method == "GET" and request.url.path.rstrip("/") == health_path.rstrip("/"):
        return True
    return False


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, api_prefix: str) -> None:
        super().__init__(app)
        self._api_prefix = api_prefix

    async def dispatch(self, request: Request, call_next) -> Response:
        if _exempt_from_general_limit(request, self._api_prefix):
            return await call_next(request)

        ip = client_ip(request)
        count_sos = _is_sos_post(request)
        if not ip_rate_limiter.try_acquire(ip, count_sos=count_sos):
            detail = "SOS submission rate limit exceeded (max 10 per hour per IP)." if count_sos else (
                "API rate limit exceeded (max 100 requests per minute per IP)."
            )
            return JSONResponse({"detail": detail}, status_code=429)

        return await call_next(request)


def _persist_request_log_sync(
    method: str,
    endpoint: str,
    client_ip_val: str,
    status_code: int,
) -> None:
    db = SessionLocal()
    try:
        db.add(
            ApiRequestLog(
                id=uuid.uuid4(),
                timestamp=datetime.now(timezone.utc),
                method=method,
                endpoint=endpoint,
                client_ip=client_ip_val,
                status_code=status_code,
            )
        )
        db.commit()
    except Exception:
        logger.exception("request log insert failed")
        db.rollback()
    finally:
        db.close()


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        if request.method == "OPTIONS":
            return response
        ip = client_ip(request)
        path = request.url.path
        status = response.status_code
        try:
            asyncio.get_running_loop().create_task(
                asyncio.to_thread(_persist_request_log_sync, request.method, path, ip, status)
            )
        except RuntimeError:
            _persist_request_log_sync(request.method, path, ip, status)
        return response
