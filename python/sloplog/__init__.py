"""
sloplog - A Python library for constructing wide events
"""

import json
import time
import datetime
import logging
import urllib.request
import traceback
from importlib.metadata import PackageNotFoundError, version
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import (
    TypedDict,
    Generic,
    TypeVar,
    Any,
    Callable,
    Literal,
    Awaitable,
    TypeGuard,
    cast,
)
import asyncio
import aiofiles  # pyright: ignore[reportMissingModuleSource]

# Re-export originator types and functions
from .originator import (
    # ID generation
    nano_id,
    # Types
    Originator,
    HttpOriginator,
    HttpMethod,
    WebSocketOriginator,
    CronOriginator,
    TracingContext,
    OriginatorFromRequestResult,
    # Constants
    ORIGINATOR_HEADER,
    TRACE_ID_HEADER,
    # Functions
    starlette_http_originator,
    flask_http_originator,
    cron_originator,
    tracing_headers,
    extract_tracing_context,
    # Private but exposed for testing
    _redact_headers,  # pyright: ignore[reportPrivateUsage, reportUnusedImport]
    _redact_query_string,  # pyright: ignore[reportPrivateUsage, reportUnusedImport]
)

# Re-export built-in partials generated from the registry
from .partials import (
    ErrorPartial,
    LogMessagePartial,
    SpanPartial,
    SloplogUsageErrorPartial,
    GeneratedPartial,
    GeneratedRegistry,
    PartialMetadata,
    PARTIAL_METADATA,
)


# Type definitions


# EventPartial is a dict with a required "type" key and arbitrary additional fields
EventPartial = dict[str, Any]
"""
An event partial is a structured bit of data added to a wide event.
Each partial has a type discriminator and arbitrary additional fields.
"""

PartialValue = EventPartial | list[EventPartial]
"""Either a single partial or a list of repeatable partials."""

LogMessageLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]
"""Allowed levels for log_message and logger-based collectors."""


class _ServiceRequired(TypedDict):
    """Required service fields"""

    name: str


class Service(_ServiceRequired, total=False):
    """
    Service information - where an event is emitted from.

    sloplogVersion and sloplogLanguage are auto-populated when omitted.
    """

    version: str
    sloplogVersion: str
    sloplogLanguage: str


def _sloplog_version() -> str:
    try:
        return version("sloplog")
    except PackageNotFoundError:
        return "0.0.0"


SLOPLOG_VERSION = _sloplog_version()
SLOPLOG_LANGUAGE = "python"


def service(details: Service) -> Service:
    """Create a Service payload with sloplog defaults applied."""
    payload = cast(Service, dict(details))
    payload.setdefault("sloplogVersion", SLOPLOG_VERSION)
    payload.setdefault("sloplogLanguage", SLOPLOG_LANGUAGE)
    return payload


@dataclass
class WideEventBase:
    """The base structure of a wide event (without partials)."""

    event_id: str
    trace_id: str
    service: Service
    originator: Originator

    def to_dict(self) -> dict[str, Any]:
        """Convert the base event to a dict with wire-format keys."""
        return {
            "eventId": self.event_id,
            "traceId": self.trace_id,
            "service": dict(self.service),
            "originator": dict(self.originator),
        }


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


def stdio_collector() -> "StdioCollector":
    """Create a collector that logs events to stdout."""
    return StdioCollector()


class CompositeCollector(LogCollectorClient):
    """Composes multiple collectors together, flushing to all of them in parallel."""

    def __init__(self, collectors: list[LogCollectorClient]):
        self._collectors = collectors

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        await asyncio.gather(*[c.flush(event, partials) for c in self._collectors])


def composite_collector(collectors: list[LogCollectorClient]) -> "CompositeCollector":
    """Create a collector that flushes to multiple collectors in parallel."""
    return CompositeCollector(collectors)


# Type alias for filter functions
EventFilter = Callable[
    [WideEventBase, dict[str, PartialValue]], bool
]  # Filter signature.


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
) -> "FilteredCollector":
    """Create a collector that filters events before flushing."""
    return FilteredCollector(collector, filter_fn)


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
) -> "BetterStackCollector":
    """Create a collector that sends events to BetterStack Logs."""
    return BetterStackCollector(
        source_token=source_token,
        host=host,
        buffer_size=buffer_size,
        flush_interval_seconds=flush_interval_seconds,
        send=send,
    )


class SentryCollector(LogCollectorClient):
    """
    Collector that sends events through a logger configured with Sentry's logging
    integration (e.g. Sentry LoggingIntegration).
    Event attributes are attached under the "sloplog" extra key.
    """

    _LEVELS: dict[LogMessageLevel, int] = {
        "trace": logging.DEBUG,
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warn": logging.WARNING,
        "error": logging.ERROR,
        "fatal": logging.CRITICAL,
    }

    def __init__(
        self,
        logger: logging.Logger,
        level: LogMessageLevel = "info",
        level_selector: Callable[
            [WideEventBase, dict[str, PartialValue]], LogMessageLevel
        ]
        | None = None,
        message: str = "wide-event",
    ):
        self._logger = logger
        self._level = level
        self._level_selector = level_selector
        self._message = message

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        attributes = {
            **event.to_dict(),
            **partials,
        }
        level = cast(
            LogMessageLevel,
            self._level_selector(event, partials)
            if self._level_selector is not None
            else self._level,
        )
        level_no = self._LEVELS.get(level, logging.INFO)
        self._logger.log(level_no, self._message, extra={"sloplog": attributes})


def sentry_collector(
    logger: logging.Logger,
    level: LogMessageLevel = "info",
    level_selector: Callable[[WideEventBase, dict[str, PartialValue]], LogMessageLevel]
    | None = None,
    message: str = "wide-event",
) -> "SentryCollector":
    """Create a collector that sends events via the configured logger."""
    return SentryCollector(
        logger=logger,
        level=level,
        level_selector=level_selector,
        message=message,
    )


class FileCollector(LogCollectorClient):
    """Collector that writes events to a file with buffering"""

    def __init__(
        self,
        file_path: str,
        buffer_size: int = 10,
        flush_interval_seconds: float = 5.0,
    ):
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
        """Wait for flush interval then flush buffer"""
        await asyncio.sleep(self._flush_interval)
        async with self._lock:
            await self._flush_buffer()

    async def _flush_buffer(self) -> None:
        """Flush the buffer to disk (must be called with lock held)"""
        current_task = asyncio.current_task()
        if self._flush_task is not None:
            if self._flush_task is not current_task:
                self._flush_task.cancel()
            self._flush_task = None

        if not self._buffer:
            return

        data = "".join(self._buffer)
        self._buffer = []

        async with aiofiles.open(self.file_path, "a") as f:
            await f.write(data)

    async def flush_buffer(self) -> None:
        """Public method to flush the buffer"""
        async with self._lock:
            await self._flush_buffer()

    async def close(self) -> None:
        """Force flush any remaining buffered events (call on shutdown)"""
        await self.flush_buffer()


def file_collector(
    file_path: str,
    buffer_size: int = 10,
    flush_interval_seconds: float = 5.0,
) -> "FileCollector":
    """Create a collector that writes events to a file with buffering."""
    return FileCollector(
        file_path=file_path,
        buffer_size=buffer_size,
        flush_interval_seconds=flush_interval_seconds,
    )


# Generic type for the registry
R = TypeVar("R", bound=dict[str, PartialValue])


class WideEvent(Generic[R]):
    """
    Core WideEvent class.

    Create one WideEvent per request or unit of work. Use partial/log/span methods
    to add structured data, then flush to emit the full wide log.

    Args:
        service: Service that the wide event is being emitted on
        originator: Originator (i.e. request, schedule, etc) of the wide event
        collector: Location to collect/flush logs to
        trace_id: Optional trace ID (for continuing an existing trace). If not provided, a new one is generated.
        partial_metadata: Optional metadata about partial repeatability and sampling.
    """

    def __init__(
        self,
        service: Service,
        originator: Originator,
        collector: LogCollectorClient,
        trace_id: str | None = None,
        partial_metadata: dict[str, dict[str, bool]] | None = None,
    ):
        self.event_id = f"evt_{nano_id()}"
        self.trace_id = trace_id or f"trace_{nano_id()}"
        self._service = service
        self._originator = originator
        self._collector = collector
        self._partial_metadata = partial_metadata or {}
        self._partials: dict[str, PartialValue] = {}
        self._open_spans: dict[str, list[int]] = {}
        self._service = cast(Service, dict(self._service))
        self._service.setdefault("sloplogVersion", SLOPLOG_VERSION)
        self._service.setdefault("sloplogLanguage", SLOPLOG_LANGUAGE)

    def partial(self, partial: EventPartial) -> None:
        """
        Add a partial to a wide event.
        Overwriting a singular partial records a sloplog_usage_error.

        Args:
            partial: wide event partial to add
        """
        self._add_partial_internal(partial)

    def log(
        self,
        arg1: EventPartial | str,
        arg2: Any | None = None,
        level: LogMessageLevel | None = None,
    ) -> None:
        """
        Add a partial or log message to a wide event.
        log(partial) is an alias for partial(partial).
        log(message, data, level) creates a log_message partial.
        Partials are always preferred over log_message for structured data.
        If data is provided, it is JSON stringified (string data is passed through).
        If level is omitted, it defaults to "info".

        Args:
            arg1: wide event partial to add, or a message string
            arg2: optional data for log_message
            level: optional log level for log_message
        """
        if isinstance(arg1, dict):
            self._add_partial_internal(arg1)
            return

        if not isinstance(arg1, str):
            self._add_usage_error("log_message_invalid", "Log message must be a string")
            return

        payload: dict[str, Any] = {
            "type": "log_message",
            "message": arg1,
            "level": level or "info",
        }

        if arg2 is not None:
            if isinstance(arg2, str):
                payload["data"] = arg2
            else:
                try:
                    payload["data"] = json.dumps(arg2)
                except (TypeError, ValueError):
                    self._add_usage_error(
                        "log_message_stringify_error",
                        "Failed to stringify log data",
                    )

        self._add_partial_internal(payload)

    def error(self, err: Any, code: int | float | None = None) -> None:
        """
        Add an error partial from an Exception or message.

        Args:
            err: Exception, message string, or error-like dict
            code: Optional numeric error code
        """
        if (
            isinstance(err, dict)
            and err.get("type") == "error"
            and isinstance(err.get("message"), str)
        ):
            self._add_partial_internal(err)
            return

        payload: dict[str, Any] = {
            "type": "error",
            "message": self._format_error_message(err),
        }

        stack = self._format_error_stack(err)
        if stack:
            payload["stack"] = stack

        if code is None and isinstance(err, dict):
            err_code = err.get("code")
            if isinstance(err_code, (int, float)):
                payload["code"] = float(err_code)
        elif isinstance(code, (int, float)):
            payload["code"] = float(code)

        self._add_partial_internal(payload)

    def span(self, name: str, fn: Callable[[], Any]) -> Any:
        """
        Time a span around a callback and emit a span partial.
        Unended spans are recorded as sloplog_usage_error on flush.
        """
        self.span_start(name)
        try:
            return fn()
        finally:
            self.span_end(name)

    def span_start(self, name: str) -> None:
        """Start a span by name."""
        started_at = int(time.time() * 1000)
        existing = self._open_spans.get(name)
        if existing:
            existing.append(started_at)
        else:
            self._open_spans[name] = [started_at]

    def span_end(self, name: str) -> None:
        """End a span by name. Missing starts are recorded as sloplog_usage_error."""
        existing = self._open_spans.get(name)
        if not existing:
            self._add_usage_error(
                "span_end_without_start",
                f'Span "{name}" ended without start',
                {"span_name": name},
            )
            return

        started_at = existing.pop()
        if not existing:
            self._open_spans.pop(name, None)

        ended_at = int(time.time() * 1000)
        duration_ms = ended_at - started_at
        self._add_partial_internal(
            {
                "type": "span",
                "name": name,
                "started_at": started_at,
                "ended_at": ended_at,
                "duration_ms": duration_ms,
            }
        )

    def to_log(self) -> dict[str, Any]:
        """Get the current state of the wide event as a log object."""
        result: dict[str, Any] = {
            "eventId": self.event_id,
            "traceId": self.trace_id,
            "service": dict(self._service),
            "originator": dict(self._originator),
        }
        for key, value in self._partials.items():
            result[key] = value
        return result

    async def flush(self) -> None:
        """
        Emit the full wide log to the collector.
        Any usage errors (e.g. unended spans, partial overwrites) are emitted
        as sloplog_usage_error partials before flushing.
        """
        self._record_open_spans()
        event_base = WideEventBase(
            event_id=self.event_id,
            trace_id=self.trace_id,
            service=self._service,
            originator=self._originator,
        )
        await self._collector.flush(event_base, self._partials)

    def _add_partial_internal(self, partial: EventPartial) -> None:
        partial_type = partial.get("type")
        if not partial_type:
            return

        metadata = self._partial_metadata.get(partial_type, {})
        repeatable = metadata.get(
            "repeatable", self._is_repeatable_fallback(partial_type)
        )

        if repeatable:
            self._append_repeatable(partial_type, partial)
            return

        if partial_type in self._partials:
            self._add_usage_error(
                "partial_overwrite",
                f'Partial "{partial_type}" was overwritten',
                {"partial_type": partial_type},
            )

        self._partials[partial_type] = partial

    def _append_repeatable(self, partial_type: str, partial: EventPartial) -> None:
        existing = self._partials.get(partial_type)
        if isinstance(existing, list):
            existing.append(partial)
            return
        if existing is not None:
            self._partials[partial_type] = [existing, partial]
            return
        self._partials[partial_type] = [partial]

    def _is_repeatable_fallback(self, partial_type: str) -> bool:
        return partial_type in {
            "error",
            "log_message",
            "span",
            "sloplog_usage_error",
        }

    def _add_usage_error(
        self, kind: str, message: str, details: dict[str, Any] | None = None
    ) -> None:
        payload: dict[str, Any] = {
            "type": "sloplog_usage_error",
            "kind": kind,
            "message": message,
        }
        if details:
            payload.update(details)
        self._append_repeatable("sloplog_usage_error", payload)

    def _record_open_spans(self) -> None:
        if not self._open_spans:
            return

        for name, starts in self._open_spans.items():
            for started_at in starts:
                self._add_usage_error(
                    "span_unended",
                    f'Span "{name}" was started but never ended',
                    {"span_name": name, "started_at": started_at},
                )
        self._open_spans.clear()

    def _format_error_message(self, err: Any) -> str:
        if isinstance(err, str):
            return err
        if isinstance(err, BaseException):
            return str(err) or err.__class__.__name__
        if isinstance(err, dict):
            message = err.get("message")
            if isinstance(message, str):
                return message
            try:
                return json.dumps(err)
            except (TypeError, ValueError):
                return "Unknown error"
        return str(err)

    def _format_error_stack(self, err: Any) -> str | None:
        if isinstance(err, BaseException):
            return "".join(
                traceback.format_exception(type(err), err, err.__traceback__)
            )
        if isinstance(err, dict):
            stack = err.get("stack")
            if isinstance(stack, str):
                return stack
        return None


def _is_originator_result(
    value: Originator | OriginatorFromRequestResult,
) -> TypeGuard[OriginatorFromRequestResult]:
    return isinstance(value, dict) and "originator" in value and "trace_id" in value


def wideevent(
    service: Service,
    originator: Originator | OriginatorFromRequestResult,
    collector: LogCollectorClient,
    trace_id: str | None = None,
    partial_metadata: dict[str, dict[str, bool]] | None = None,
) -> WideEvent[dict[str, PartialValue]]:
    """
    Create a WideEvent instance. Prefer this factory over class construction.

    originator can be a raw Originator or an OriginatorFromRequestResult.
    When a result is provided, its trace_id is used unless trace_id is set explicitly.
    """
    resolved_originator: Originator
    if _is_originator_result(originator):
        resolved_originator = originator["originator"]
        trace_id = trace_id or originator["trace_id"]
    else:
        resolved_originator = cast(Originator, originator)

    return WideEvent(
        service=service,
        originator=resolved_originator,
        collector=collector,
        trace_id=trace_id,
        partial_metadata=partial_metadata,
    )


__all__ = [
    # Core
    "nano_id",
    "EventPartial",
    "PartialValue",
    "LogMessageLevel",
    "Service",
    "service",
    "SLOPLOG_VERSION",
    "SLOPLOG_LANGUAGE",
    "WideEventBase",
    "WideEvent",
    "wideevent",
    # Built-in partials
    "ErrorPartial",
    "LogMessagePartial",
    "SpanPartial",
    "SloplogUsageErrorPartial",
    "GeneratedPartial",
    "GeneratedRegistry",
    "PartialMetadata",
    "PARTIAL_METADATA",
    # Originators
    "Originator",
    "HttpOriginator",
    "HttpMethod",
    "WebSocketOriginator",
    "CronOriginator",
    "OriginatorFromRequestResult",
    # Originator helpers
    "ORIGINATOR_HEADER",
    "TRACE_ID_HEADER",
    "starlette_http_originator",
    "flask_http_originator",
    "cron_originator",
    # Tracing helpers
    "TracingContext",
    "tracing_headers",
    "extract_tracing_context",
]
