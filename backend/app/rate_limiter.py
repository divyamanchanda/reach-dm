"""In-process per-IP rate limits (fixed windows). Use one worker or accept per-process limits."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class IpRateLimiter:
    """Track request timestamps per IP under a threading lock."""

    def __init__(self, *, general_per_minute: int = 100, sos_per_hour: int = 10) -> None:
        self._general_per_minute = general_per_minute
        self._sos_per_hour = sos_per_hour
        self._lock = threading.Lock()
        self._general: dict[str, deque[float]] = defaultdict(deque)
        self._sos: dict[str, deque[float]] = defaultdict(deque)

    @staticmethod
    def _prune(dq: deque[float], window_sec: float, now: float) -> None:
        while dq and dq[0] <= now - window_sec:
            dq.popleft()

    def try_acquire(self, ip: str, *, count_sos: bool) -> bool:
        """Atomically record one general hit and optionally one SOS hit. Returns False if over limit."""
        now = time.time()
        with self._lock:
            g = self._general[ip]
            self._prune(g, 60.0, now)
            if len(g) >= self._general_per_minute:
                return False
            if count_sos:
                s = self._sos[ip]
                self._prune(s, 3600.0, now)
                if len(s) >= self._sos_per_hour:
                    return False
                s.append(now)
            g.append(now)
            return True


ip_rate_limiter = IpRateLimiter()
