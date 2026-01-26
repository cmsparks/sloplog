"""Stdio collector for sloplog."""

import json

from ..core import PartialValue, WideEventBase
from .base import LogCollectorClient


class StdioCollector(LogCollectorClient):
    """Simple collector that logs the event JSON to stdout."""

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        log_data = {
            **event.to_dict(),
            **partials,
        }
        print(json.dumps(log_data))


def stdio_collector() -> StdioCollector:
    """Create a collector that logs events to stdout."""
    return StdioCollector()
