"""SQLite job records plus a bounded in-process worker pool.

Jobs run in this process. A restart cannot resume a half-finished Blender or
provider call, so queued/running rows are marked failed on startup instead of
silently disappearing.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sqlite3
import threading
import uuid

logger = logging.getLogger("tadaima.service")


class JobFailure(RuntimeError):
    """A job failed with a message that is safe to return to API clients."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, database: Path):
        self.database = database
        self._lock = threading.Lock()
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                params TEXT NOT NULL, result TEXT, error TEXT)""")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _update(self, job_id: str, **fields: object) -> None:
        columns = ", ".join(f"{name} = ?" for name in fields)
        with self._lock, self._connect() as connection:
            connection.execute(f"UPDATE jobs SET {columns} WHERE id = ?", (*fields.values(), job_id))

    def create(self, kind: str, params: dict) -> str:
        job_id = uuid.uuid4().hex
        with self._lock, self._connect() as connection:
            connection.execute("INSERT INTO jobs (id, kind, status, created_at, params) VALUES (?, ?, 'queued', ?, ?)",
                               (job_id, kind, _now(), json.dumps(params, allow_nan=False)))
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return {"id": row["id"], "kind": row["kind"], "status": row["status"],
                "createdAt": row["created_at"], "startedAt": row["started_at"], "finishedAt": row["finished_at"],
                "params": json.loads(row["params"]),
                "result": json.loads(row["result"]) if row["result"] else None,
                "error": json.loads(row["error"]) if row["error"] else None}

    def mark_running(self, job_id: str) -> None:
        self._update(job_id, status="running", started_at=_now())

    def mark_succeeded(self, job_id: str, result: dict) -> None:
        self._update(job_id, status="succeeded", finished_at=_now(), result=json.dumps(result, allow_nan=False))

    def mark_failed(self, job_id: str, error: str, message: str) -> None:
        self._update(job_id, status="failed", finished_at=_now(),
                     error=json.dumps({"error": error, "message": message}))

    def fail_interrupted(self) -> int:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE status IN ('queued', 'running')",
                (_now(), json.dumps({"error": "Interrupted", "message": "The service restarted before this job finished; submit it again."})))
            return cursor.rowcount


class JobRunner:
    def __init__(self, store: JobStore, jobs_dir: Path, workers: int):
        self.store = store
        self.jobs_dir = jobs_dir
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tadaima-job")

    def job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id

    def submit(self, job_id: str, work: Callable[[Path], dict]) -> None:
        self._executor.submit(self._run, job_id, work)

    def _run(self, job_id: str, work: Callable[[Path], dict]) -> None:
        self.store.mark_running(job_id)
        try:
            result = work(self.job_dir(job_id))
        except JobFailure as error:
            logger.warning("job %s failed: %s", job_id, error)
            self.store.mark_failed(job_id, type(error.__cause__ or error).__name__, str(error))
        except Exception:
            # Unknown failures may carry private paths or provider bodies; log them, return a generic message.
            logger.exception("job %s crashed", job_id)
            self.store.mark_failed(job_id, "InternalError", "Reconstruction failed unexpectedly; see service logs.")
        else:
            self.store.mark_succeeded(job_id, result)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
