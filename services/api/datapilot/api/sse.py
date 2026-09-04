"""Server-sent events over the persisted ``events.jsonl`` of a run (spec §7).

The stream is a thin tail of the file: on connect it replays every persisted event with
``seq > after``, then polls the file for new lines. It stops once the run has reached a
terminal lifecycle, no pipeline job is active, and everything on disk has been sent; or as
soon as the client disconnects. A ``: heartbeat`` comment keeps idle connections alive.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable

from fastapi import Request
from fastapi.responses import StreamingResponse

from datapilot.contracts.models import RunEvent
from datapilot.storage import RunStore

POLL_INTERVAL_SECONDS = 0.25
HEARTBEAT_SECONDS = 10.0
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def format_event(event: RunEvent) -> str:
    payload = json.dumps(event.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    return f"id: {event.seq}\nevent: run_event\ndata: {payload}\n\n"


async def event_stream(
    store: RunStore,
    run_id: str,
    after: int,
    *,
    is_active: Callable[[], bool],
    request: Request | None = None,
    poll_interval: float = POLL_INTERVAL_SECONDS,
    heartbeat_interval: float = HEARTBEAT_SECONDS,
) -> AsyncIterator[str]:
    """Yield SSE frames for ``run_id``.

    ``is_active`` must return ``True`` while the run may still produce events (lifecycle
    ``QUEUED``/``RUNNING`` or a draft/brief job in flight). It is sampled *before* each read so
    that an event appended just before the run became inactive is never skipped.
    """
    last_seq = max(after, 0)
    loop = asyncio.get_running_loop()
    last_activity = loop.time()
    while True:
        if request is not None and await request.is_disconnected():
            return
        active = is_active()
        events = await asyncio.to_thread(store.read_events, run_id, last_seq)
        if events:
            for event in events:
                last_seq = max(last_seq, event.seq)
                yield format_event(event)
            last_activity = loop.time()
        elif not active:
            return
        elif loop.time() - last_activity >= heartbeat_interval:
            yield ": heartbeat\n\n"
            last_activity = loop.time()
        if not events and active:
            await asyncio.sleep(poll_interval)


def sse_response(stream: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(stream, media_type="text/event-stream", headers=dict(SSE_HEADERS))
