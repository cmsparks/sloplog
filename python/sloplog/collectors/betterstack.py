"""BetterStack collector for sloplog."""

import json
import datetime
import asyncio
import urllib.request
from typing import Any, Callable, Awaitable

from ..core import PartialValue, WideEventBase
from .base import LogCollectorClient


class BetterStackCollector(LogCollectorClient):
    """
    Collector that sends events to BetterStack Logs via HTTP API.
    Uses buffered batching to reduce network overhead.
    """

    def __init__(
        self,
        source_token: str,
        host: str = "in.logs.betterstack.com",
        buffer_size: int = 10,
        flush_interval_seconds: float = 5.0,
        send: Callable[[str, dict[str, str], str], Awaitable[None]] | None = None,
    ):
        self._source_token = source_token
        self._host = host
        self._buffer: list[dict[str, Any]] = []
        self._buffer_size = buffer_size
        self._flush_interval = flush_interval_seconds
        self._flush_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._send = send or self._default_send

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        timestamp = (
            datetime.datetime.now(datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
        log_entry = {
            "dt": timestamp,
            **event.to_dict(),
            **partials,
        }

        async with self._lock:
            self._buffer.append(log_entry)

            if self._flush_task is None:
                self._flush_task = asyncio.create_task(self._delayed_flush())

            if len(self._buffer) >= self._buffer_size:
                await self._flush_buffer()

    async def _delayed_flush(self) -> None:
        await asyncio.sleep(self._flush_interval)
        async with self._lock:
            await self._flush_buffer()

    async def _flush_buffer(self) -> None:
        current_task = asyncio.current_task()
        if self._flush_task is not None:
            if self._flush_task is not current_task:
                self._flush_task.cancel()
            self._flush_task = None

        if not self._buffer:
            return

        batch = self._buffer
        self._buffer = []

        url = f"https://{self._host}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._source_token}",
        }
        body = json.dumps(batch)
        await self._send(url, headers, body)

    async def flush_buffer(self) -> None:
        """Public method to flush the buffer."""
        async with self._lock:
            await self._flush_buffer()

    async def close(self) -> None:
        """Force flush any remaining buffered events (call on shutdown)."""
        await self.flush_buffer()

    async def _default_send(self, url: str, headers: dict[str, str], body: str) -> None:
        def _post() -> None:
            req = urllib.request.Request(
                url,
                data=body.encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req) as response:
                response.read()

        await asyncio.to_thread(_post)


def betterstack_collector(
    source_token: str,
    host: str = "in.logs.betterstack.com",
    buffer_size: int = 10,
    flush_interval_seconds: float = 5.0,
    send: Callable[[str, dict[str, str], str], Awaitable[None]] | None = None,
) -> BetterStackCollector:
    """Create a collector that sends events to BetterStack Logs."""
    return BetterStackCollector(
        source_token=source_token,
        host=host,
        buffer_size=buffer_size,
        flush_interval_seconds=flush_interval_seconds,
        send=send,
    )
