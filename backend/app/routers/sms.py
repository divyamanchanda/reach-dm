"""Inbound SMS webhooks (Twilio / MSG91) — creates incidents like public SOS."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Corridor
from app.schemas import PublicIncidentCreate, SmsIncomingResponse, SmsTestBody
from app.services.public_incident import create_public_incident_row
from app.services.sms_outbound import send_sms_reply
from app.services.sms_parser import ParsedSms, parse_sms_body
from app.routers.incidents import _push_corridor_stats, _push_incident_new

router = APIRouter(prefix="/sms", tags=["sms"])


def _resolve_corridor_id(db: Session, corridor_hint: str | None) -> uuid.UUID:
    q = select(Corridor).where(Corridor.is_active.is_(True)).order_by(Corridor.name)
    rows = list(db.execute(q).scalars().all())
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No active corridors configured",
        )
    if corridor_hint:
        hint = corridor_hint.strip().upper()
        for c in rows:
            if c.code and c.code.strip().upper() == hint:
                return c.id
    return rows[0].id


def _format_km_display(km: float | None) -> str | None:
    if km is None:
        return None
    if km == int(km):
        return str(int(km))
    return str(km)


def _build_reply_text(incident_id: uuid.UUID, parsed: ParsedSms) -> str:
    km_disp = _format_km_display(parsed.km_marker)
    if km_disp is not None:
        return (
            f"REACH received your SOS at KM{km_disp}. "
            f"Help is being dispatched. Stay safe. Ref: {incident_id}"
        )
    return (
        f"REACH received your SOS. Help is being dispatched. Stay safe. Ref: {incident_id}"
    )


def _extract_from_payload(data: dict[str, Any]) -> tuple[str, str]:
    msg = (
        data.get("Body")
        or data.get("body")
        or data.get("text")
        or data.get("message")
        or data.get("content")
        or ""
    )
    if not isinstance(msg, str):
        msg = str(msg)
    phone = (
        data.get("From")
        or data.get("from")
        or data.get("mobile")
        or data.get("mobiles")
        or data.get("sender")
        or data.get("FromMobile")
        or ""
    )
    if not isinstance(phone, str):
        phone = str(phone)
    return (msg.strip(), phone.strip())


async def _parse_inbound_request(request: Request) -> tuple[str, str]:
    ct = (request.headers.get("content-type") or "").lower()
    if "application/json" in ct:
        try:
            raw = await request.json()
        except Exception:
            raw = {}
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="JSON body must be an object")
        msg, phone = _extract_from_payload(raw)
    else:
        form = await request.form()
        data = {str(k): v for k, v in form.items()}
        msg, phone = _extract_from_payload(data)
    if not msg:
        raise HTTPException(status_code=400, detail="Missing SMS body")
    if not phone:
        raise HTTPException(status_code=400, detail="Missing sender phone")
    return msg, phone


def _process_sms(
    db: Session,
    message: str,
    from_phone: str,
    background_tasks: BackgroundTasks,
) -> SmsIncomingResponse:
    parsed = parse_sms_body(message)
    corridor_id = _resolve_corridor_id(db, parsed.corridor_hint)
    body = PublicIncidentCreate(
        incident_type=parsed.incident_type,
        severity=parsed.severity,
        injured_count=parsed.injured_count,
        km_marker=parsed.km_marker,
        notes=f"SMS: {parsed.raw_text}",
    )
    result = create_public_incident_row(
        db,
        corridor_id,
        body,
        reporter_type="sms_sos",
        incident_source="sms",
        is_sms=True,
        event_source="sms",
    )
    reply_text = _build_reply_text(result.incident_id, parsed)
    reply_sent = send_sms_reply(from_phone, reply_text)
    background_tasks.add_task(_push_incident_new, corridor_id, {"incident_id": str(result.incident_id)})
    background_tasks.add_task(_push_corridor_stats, corridor_id)
    return SmsIncomingResponse(
        incident_id=result.incident_id,
        corridor_id=corridor_id,
        public_report_id=result.public_report_id,
        reply_text=reply_text,
        reply_sent=reply_sent,
    )


@router.post("/incoming", response_model=SmsIncomingResponse)
async def post_sms_incoming(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    message, from_phone = await _parse_inbound_request(request)
    return _process_sms(db, message, from_phone, background_tasks)


@router.post("/test", response_model=SmsIncomingResponse)
def post_sms_test(
    payload: SmsTestBody,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return _process_sms(db, payload.message, payload.from_, background_tasks)
