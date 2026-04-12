"""Send outbound SMS replies (Twilio or MSG91). Logs and no-ops if not configured."""

from __future__ import annotations

import logging
from urllib.parse import quote_plus

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


def send_sms_reply(to_e164: str, body: str) -> bool:
    """Return True if the provider accepted the message (or dry-run)."""
    to_e164 = (to_e164 or "").strip()
    if not to_e164:
        logger.warning("SMS reply skipped: empty destination")
        return False

    provider = (settings.sms_provider or "").strip().lower()
    if not provider or provider == "none":
        logger.info("SMS reply not sent (SMS_PROVIDER unset): to=%s body=%s", to_e164, body[:120])
        return True

    if provider == "twilio":
        return _twilio_send(to_e164, body)
    if provider in ("msg91", "msg_91"):
        return _msg91_send(to_e164, body)

    logger.warning("Unknown SMS_PROVIDER=%s; not sending", provider)
    return False


def _twilio_send(to_e164: str, body: str) -> bool:
    sid = settings.twilio_account_sid
    token = settings.twilio_auth_token
    from_num = settings.twilio_from_number
    if not sid or not token or not from_num:
        logger.warning("Twilio SMS skipped: missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER")
        return False
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    try:
        with httpx.Client(timeout=12.0) as client:
            r = client.post(
                url,
                auth=(sid, token),
                data={"To": to_e164, "From": from_num, "Body": body},
            )
        if r.status_code >= 400:
            logger.error("Twilio SMS error %s: %s", r.status_code, r.text[:500])
            return False
        return True
    except Exception as e:
        logger.exception("Twilio SMS failed: %s", e)
        return False


def _msg91_send(to_e164: str, body: str) -> bool:
    key = settings.msg91_auth_key
    sender = settings.msg91_sender_id
    if not key or not sender:
        logger.warning("MSG91 SMS skipped: missing MSG91_AUTH_KEY / MSG91_SENDER_ID")
        return False
    # Expect international format without + for MSG91 (e.g. 9198xxxxxxxx)
    mobiles = to_e164.lstrip("+")
    route = settings.msg91_route or "4"
    encoded = quote_plus(body)
    url = (
        f"https://api.msg91.com/api/sendhttp.php?authkey={key}&mobiles={mobiles}"
        f"&message={encoded}&sender={sender}&route={route}&country=0"
    )
    try:
        with httpx.Client(timeout=12.0) as client:
            r = client.get(url)
        if r.status_code != 200:
            logger.error("MSG91 SMS error %s: %s", r.status_code, r.text[:500])
            return False
        return True
    except Exception as e:
        logger.exception("MSG91 SMS failed: %s", e)
        return False
