"""
sloplog - A Python library for constructing wide events
"""

import json
import time
import traceback
from typing import (
    Generic,
    TypeVar,
    Any,
    Callable,
    TypeGuard,
    cast,
)

# Re-export core types
from .core import (
    EventPartial,
    PartialValue,
    LogMessageLevel,
    Service,
    service,
    SLOPLOG_VERSION,
    SLOPLOG_LANGUAGE,
    WideEventBase,
)

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

# Re-export base collector types (always available, no external deps)
from .collectors import (
    LogCollectorClient,
    EventFilter,
    CompositeCollector,
    FilteredCollector,
    StdioCollector,
    composite_collector,
    filtered_collector,
    stdio_collector,
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
    # Base collector types (always available)
    "LogCollectorClient",
    "EventFilter",
    "CompositeCollector",
    "FilteredCollector",
    "StdioCollector",
    "composite_collector",
    "filtered_collector",
    "stdio_collector",
]
