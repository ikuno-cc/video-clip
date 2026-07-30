import threading
import time
from typing import Any, Optional

from fastapi import HTTPException


class TrimState:
    def __init__(self, max_concurrency: int, status_ttl_seconds: int) -> None:
        self._max_concurrency = max(1, int(max_concurrency))
        self._status_ttl_seconds = max(60, int(status_ttl_seconds))
        self._semaphore = threading.BoundedSemaphore(self._max_concurrency)
        self._lock = threading.Lock()
        self._status: dict[str, dict[str, Any]] = {}

    def _prune(self, now_ts: float) -> None:
        to_delete = []
        for request_id, item in self._status.items():
            status = str(item.get("status", ""))
            updated = float(item.get("updated_at", now_ts))
            if status in {"completed", "failed"} and (now_ts - updated) > self._status_ttl_seconds:
                to_delete.append(request_id)
        for request_id in to_delete:
            self._status.pop(request_id, None)

    def set_status(self, request_id: str, status: str, message: Optional[str] = None) -> None:
        now_ts = time.time()
        with self._lock:
            self._prune(now_ts)
            payload = {"status": status, "updated_at": now_ts}
            if message:
                payload["message"] = message
            self._status[request_id] = payload

    def get_status(self, request_id: str) -> Optional[dict]:
        now_ts = time.time()
        with self._lock:
            self._prune(now_ts)
            item = self._status.get(request_id)
            if not item:
                return None
            return {
                "request_id": request_id,
                "status": item.get("status"),
                "updated_at": item.get("updated_at"),
                "message": item.get("message"),
            }

    def begin(self, request_id: str) -> None:
        with self._lock:
            existing = self._status.get(request_id)
            if existing and existing.get("status") == "running":
                raise HTTPException(
                    status_code=409,
                    detail={
                        "request_id": request_id,
                        "status": "running",
                        "message": "A trim request with this request_id is already running.",
                    },
                )
        if not self._semaphore.acquire(blocking=False):
            raise HTTPException(
                status_code=429,
                detail={
                    "request_id": request_id,
                    "status": "running",
                    "message": "Server is busy. Too many concurrent trim requests.",
                },
            )
        self.set_status(request_id, "running")

    def end(self, request_id: str, status: str, message: Optional[str] = None) -> None:
        self.set_status(request_id, status, message)
        self._semaphore.release()


def guarded_call(trim_state: TrimState, request_id: str, fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except HTTPException as exc:
        trim_state.end(request_id, "failed", str(exc.detail))
        raise
    except Exception as exc:
        trim_state.end(request_id, "failed", str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc

