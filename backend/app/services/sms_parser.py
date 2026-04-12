"""Parse inbound SOS SMS into structured fields (tolerant of missing tokens)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_INCIDENT_TYPES = ("accident", "fire", "breakdown", "medical", "other")
_SEVERITIES = ("critical", "major", "minor")
@dataclass
class ParsedSms:
    km_marker: float | None
    incident_type: str
    severity: str
    injured_count: int
    corridor_hint: str | None
    raw_text: str


def _first_word_match(text_lower: str, words: tuple[str, ...]) -> str | None:
    for w in words:
        if re.search(rf"\b{re.escape(w)}\b", text_lower):
            return w
    return None


def parse_sms_body(text: str) -> ParsedSms:
    raw = (text or "").strip()
    if not raw:
        return ParsedSms(
            km_marker=None,
            incident_type="other",
            severity="major",
            injured_count=0,
            corridor_hint=None,
            raw_text=raw,
        )

    s = re.sub(r"\s+", " ", raw)
    lower = s.lower()

    km_marker: float | None = None
    m_km = re.search(r"\bkm\s*(\d+(?:\.\d+)?)\b", lower)
    if m_km:
        km_marker = float(m_km.group(1))

    injured_count = 0
    m_inj = re.search(r"\b(\d+)\s*injured\b", lower) or re.search(r"\b(\d+)injured\b", lower)
    if m_inj:
        injured_count = int(m_inj.group(1))

    corridor_hint: str | None = None
    m_cor = re.search(r"\b(NH\d{1,4})\b", s, re.IGNORECASE)
    if m_cor:
        corridor_hint = m_cor.group(1).upper()

    sev = _first_word_match(lower, _SEVERITIES)
    if not sev:
        sev = "major"

    itype = _first_word_match(lower, _INCIDENT_TYPES)
    if not itype:
        itype = "other"

    return ParsedSms(
        km_marker=km_marker,
        incident_type=itype,
        severity=sev,
        injured_count=injured_count,
        corridor_hint=corridor_hint,
        raw_text=raw,
    )
