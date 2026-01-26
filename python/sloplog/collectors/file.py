"""File collector for sloplog."""

import json
import asyncio

from ..core import PartialValue, WideEventBase
from .base import LogCollectorClient

# aiofiles is an optional dependency
_aiofiles_available = False
try:
    import aiofiles

    _aiofiles_available = True
except ImportError:
    pass


class FileCollector(LogCollectorClient):
    """Collector that writes events to a file with buffering."""

    def __init__(
        self,
        file_path: str,
        buffer_size: int = 10,
        flush_interval_seconds: float = 5.0,
    ):
        if not _aiofiles_available:
            raise ImportError(
                "aiofiles is required for FileCollector. Install it with: pip install aiofiles"
            )

        self.file_path = file_path
        self._buffer: list[str] = []
        self._buffer_size = buffer_size
        self._flush_interval = flush_interval_seconds
        self._flush_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        log_data = {
            **event.to_dict(),
            **partials,
        }
        line = json.dumps(log_data) + "\n"

        async with self._lock:
            self._buffer.append(line)

            # Start flush timer if not already running
            if self._flush_task is None:
                self._flush_task = asyncio.create_task(self._delayed_flush())

            # Flush immediately if buffer is full
            if len(self._buffer) >= self._buffer_size:
                await self._flush_buffer()

    async def _delayed_flush(self) -> None:
        """Wait for flush interval then flush buffer."""
        await asyncio.sleep(self._flush_interval)
        async with self._lock:
            await self._flush_buffer()

    async def _flush_buffer(self) -> None:
        """Flush the buffer to disk (must be called with lock held)."""
        current_task = asyncio.current_task()
        if self._flush_task is not None:
            if self._flush_task is not current_task:
                self._flush_task.cancel()
            self._flush_task = None

        if not self._buffer:
            return

        data = "".join(self._buffer)
        self._buffer = []

        async with aiofiles.open(self.file_path, "a") as f:  # pyright: ignore[reportPossiblyUnboundVariable]
            await f.write(data)

    async def flush_buffer(self) -> None:
        """Public method to flush the buffer."""
        async with self._lock:
            await self._flush_buffer()

    async def close(self) -> None:
        """Force flush any remaining buffered events (call on shutdown)."""
        await self.flush_buffer()


def file_collector(
    file_path: str,
    buffer_size: int = 10,
    flush_interval_seconds: float = 5.0,
) -> FileCollector:
    """Create a collector that writes events to a file with buffering."""
    return FileCollector(
        file_path=file_path,
        buffer_size=buffer_size,
        flush_interval_seconds=flush_interval_seconds,
    )
