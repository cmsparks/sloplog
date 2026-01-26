"""Base collector types and utilities for sloplog."""

import asyncio
from abc import ABC, abstractmethod
from typing import Any, Callable

from ..core import PartialValue, WideEventBase


MAX_STACK_LINES = 10
"""Maximum number of stack trace lines to include in flattened logs."""


def truncate_stack(stack: str | None) -> str | None:
    """Truncate a stack trace to MAX_STACK_LINES lines."""
    if not stack:
        return stack
    lines = stack.split("\n")
    if len(lines) <= MAX_STACK_LINES:
        return stack
    return "\n".join(lines[:MAX_STACK_LINES]) + "\n    ... truncated"


def flatten_object(
    obj: Any,
    prefix: str = "",
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Flatten a nested object to dot-notation keys.
    Arrays use numeric indices: `partialName.0.subKey`
    Stack traces are automatically truncated.
    """
    if result is None:
        result = {}

    if obj is None:
        if prefix:
            result[prefix] = obj
        return result

    if isinstance(obj, list):
        for i, item in enumerate(obj):
            flatten_object(item, f"{prefix}.{i}" if prefix else str(i), result)
        return result

    if isinstance(obj, dict):
        for key, value in obj.items():
            new_key = f"{prefix}.{key}" if prefix else key
            # Truncate stack traces
            if key == "stack" and isinstance(value, str):
                result[new_key] = truncate_stack(value)
            else:
                flatten_object(value, new_key, result)
        return result

    if prefix:
        result[prefix] = obj
    return result


class LogCollectorClient(ABC):
    """
    Collectors adapt the log to some format and flush to an external service.
    Partials may be single objects or lists for repeatable partials.
    """

    @abstractmethod
    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        """Flush the wide event to the collector"""
        pass


# Type alias for filter functions
EventFilter = Callable[[WideEventBase, dict[str, PartialValue]], bool]


class CompositeCollector(LogCollectorClient):
    """Composes multiple collectors together, flushing to all of them in parallel."""

    def __init__(self, collectors: list[LogCollectorClient]):
        self._collectors = collectors

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        await asyncio.gather(*[c.flush(event, partials) for c in self._collectors])


def composite_collector(collectors: list[LogCollectorClient]) -> CompositeCollector:
    """Create a collector that flushes to multiple collectors in parallel."""
    return CompositeCollector(collectors)


class FilteredCollector(LogCollectorClient):
    """Wraps a collector and only flushes events that pass the filter function."""

    def __init__(self, collector: LogCollectorClient, filter_fn: EventFilter):
        self._collector = collector
        self._filter = filter_fn

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        if self._filter(event, partials):
            await self._collector.flush(event, partials)


def filtered_collector(
    collector: LogCollectorClient, filter_fn: EventFilter
) -> FilteredCollector:
    """Create a collector that filters events before flushing."""
    return FilteredCollector(collector, filter_fn)
