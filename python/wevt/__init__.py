"""
wevt - A Python library for constructing wide events
"""

import random
import string
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TypedDict, Generic, TypeVar, Any, Callable, Literal
import asyncio
import aiofiles
import base64
import time


def nano_id() -> str:
    """Generate a nano ID for unique identifiers"""
    chars = string.ascii_letters + string.digits + "-_"
    return "".join(random.choice(chars) for _ in range(21))


# Type definitions


# EventPartial is a dict with a required "type" key and arbitrary additional fields
EventPartial = dict[str, Any]
"""
An event partial is a structured bit of data added to a wide event.
Each partial has a type discriminator and arbitrary additional fields.
"""


class Service(TypedDict, total=False):
    """Service information - where an event is emitted from"""

    name: str
    version: str


class Originator(TypedDict, total=False):
    """
    Base originator interface - an external thing that triggered your service.
    This is like a trace that can cross service boundaries.
    """

    originator_id: str  # Unique identifier for this originator chain
    type: str  # Type discriminator
    timestamp: int  # Unix timestamp in milliseconds
    parent_id: str  # Parent originator ID if this is a child span


# HTTP method types
HttpMethod = Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]


class HttpOriginator(Originator, total=False):
    """HTTP request originator"""

    method: HttpMethod
    path: str
    query: str  # Query string (without leading ?)
    headers: dict[str, str]
    client_ip: str
    user_agent: str
    content_type: str
    content_length: int
    http_version: str
    host: str


class WebSocketOriginator(Originator, total=False):
    """WebSocket message originator"""

    session_id: str
    source: str
    message_type: Literal["text", "binary"]
    message_size: int


class CronOriginator(Originator, total=False):
    """Cron/scheduled task originator"""

    cron: str
    job_name: str
    scheduled_time: int  # Unix timestamp in milliseconds


# Header name for propagating originator across services
ORIGINATOR_HEADER = "x-wevt-originator"
# Header name for propagating trace ID across services
TRACE_ID_HEADER = "x-wevt-trace-id"


class SerializedOriginator(TypedDict, total=False):
    """Serializable originator data for cross-service propagation"""

    v: int  # version
    id: str
    t: str  # type
    ts: int  # timestamp
    pid: str  # parentId
    d: dict[str, Any]  # additional data


def serialize_originator(originator: Originator) -> str:
    """Serialize an originator to a base64 string for header propagation"""
    serialized: SerializedOriginator = {
        "v": 1,
        "id": originator.get("originator_id", ""),
        "t": originator.get("type", ""),
        "ts": originator.get("timestamp", 0),
    }

    if parent_id := originator.get("parent_id"):
        serialized["pid"] = parent_id

    # Collect additional data
    known_keys = {"originator_id", "type", "timestamp", "parent_id"}
    extra_data = {k: v for k, v in originator.items() if k not in known_keys}
    if extra_data:
        serialized["d"] = extra_data

    json_str = json.dumps(serialized)
    # Use URL-safe base64 encoding
    return base64.urlsafe_b64encode(json_str.encode()).decode().rstrip("=")


def deserialize_originator(encoded: str) -> Originator | None:
    """Deserialize an originator from a base64 string"""
    try:
        # Restore padding
        padding = 4 - len(encoded) % 4
        if padding != 4:
            encoded += "=" * padding

        json_str = base64.urlsafe_b64decode(encoded).decode()
        serialized: SerializedOriginator = json.loads(json_str)

        if serialized.get("v") != 1:
            return None

        result: Originator = {
            "originator_id": serialized["id"],
            "type": serialized["t"],
            "timestamp": serialized["ts"],
        }

        if pid := serialized.get("pid"):
            result["parent_id"] = pid

        if extra_data := serialized.get("d"):
            result.update(extra_data)  # type: ignore

        return result
    except Exception:
        return None


def create_originator_headers(originator: Originator) -> dict[str, str]:
    """
    Create headers dict with originator for outgoing requests.

    Deprecated: Use create_tracing_headers instead for proper trace propagation.
    """
    return {ORIGINATOR_HEADER: serialize_originator(originator)}


def extract_originator_from_headers(
    headers: dict[str, str | list[str] | None]
) -> Originator | None:
    """
    Extract originator from incoming request headers.
    Returns None if no originator header is present or if parsing fails.
    """
    # Case-insensitive header lookup
    header_value = None
    for key, value in headers.items():
        if key.lower() == ORIGINATOR_HEADER.lower():
            header_value = value
            break
    if not header_value:
        return None
    value = header_value[0] if isinstance(header_value, list) else header_value
    return deserialize_originator(value)


class TracingContext(TypedDict):
    """Tracing context to propagate across services"""

    trace_id: str  # The trace ID (stays constant across the entire distributed trace)
    originator_id: str  # The originator ID of the calling service (becomes parent_id in the callee)


def create_tracing_headers(context: TracingContext) -> dict[str, str]:
    """Create headers for propagating tracing context to downstream services"""
    return {
        TRACE_ID_HEADER: context["trace_id"],
        ORIGINATOR_HEADER: context["originator_id"],
    }


def extract_tracing_context(
    headers: dict[str, str | list[str] | None]
) -> TracingContext | None:
    """
    Extract tracing context from incoming request headers.
    Returns None if tracing headers are not present.
    """
    trace_id_value: str | None = None
    originator_id_value: str | None = None

    for key, value in headers.items():
        lower_key = key.lower()
        if lower_key == TRACE_ID_HEADER.lower():
            trace_id_value = value[0] if isinstance(value, list) else value
        elif lower_key == ORIGINATOR_HEADER.lower():
            originator_id_value = value[0] if isinstance(value, list) else value

    if not trace_id_value or not originator_id_value:
        return None

    return {
        "trace_id": trace_id_value,
        "originator_id": originator_id_value,
    }


def _now_ms() -> int:
    """Get current time in milliseconds"""
    return int(time.time() * 1000)


# Placeholder for redacted values
REDACTED = "[REDACTED]"

# Headers that should be redacted (case-insensitive)
SENSITIVE_HEADERS = {
    "authorization",
    "x-api-key",
    "x-auth-token",
    "cookie",
    "set-cookie",
}

# Query parameters that should be redacted (case-insensitive)
SENSITIVE_QUERY_PARAMS = {
    "code",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "secret",
    "password",
}


def _redact_headers(headers: dict[str, str]) -> dict[str, str]:
    """Redact sensitive headers from a headers dict"""
    redacted: dict[str, str] = {}
    for key, value in headers.items():
        if key.lower() in SENSITIVE_HEADERS:
            redacted[key] = REDACTED
        else:
            redacted[key] = value
    return redacted


def _redact_query_string(query: str | None) -> str | None:
    """Redact sensitive query parameters from a query string"""
    if not query:
        return query

    from urllib.parse import parse_qs, urlencode

    params = parse_qs(query, keep_blank_values=True)
    redacted_params: dict[str, list[str]] = {}

    for key, values in params.items():
        if key.lower() in SENSITIVE_QUERY_PARAMS:
            redacted_params[key] = [REDACTED] * len(values)
        else:
            redacted_params[key] = values

    # urlencode with doseq=True handles lists properly
    result = urlencode(redacted_params, doseq=True)
    return result if result else None


class OriginatorFromRequestResult(TypedDict):
    """
    Result of creating an originator from an incoming request.
    Contains both the originator and the extracted trace_id (if any).
    """

    originator: HttpOriginator  # The created HTTP originator
    trace_id: str  # The trace ID extracted from headers, or a newly generated one


def create_originator_from_starlette_request(
    request: Any,
    originator_id: str | None = None,
) -> OriginatorFromRequestResult:
    """
    Create an HTTP originator from a Starlette/FastAPI Request.

    Extracts tracing context from headers if present:
    - trace_id: extracted from x-wevt-trace-id header, or generated if not present
    - parent_id: set to the incoming x-wevt-originator header value (the caller's originator_id)

    Args:
        request: Starlette Request object
        originator_id: Optional override for originator ID
    """
    headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

    # Check for incoming tracing context
    tracing_context = extract_tracing_context(headers)  # type: ignore[arg-type]

    # Get client IP
    client_ip = headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not client_ip and hasattr(request, "client") and request.client:
        client_ip = request.client.host

    # Redact sensitive data
    redacted_headers = _redact_headers(headers)
    query = request.url.query if request.url.query else None
    redacted_query = _redact_query_string(query)

    originator: HttpOriginator = {
        "originator_id": originator_id or f"orig_{nano_id()}",
        "type": "http",
        "timestamp": _now_ms(),
        "method": request.method.upper(),
        "path": request.url.path,
        "headers": redacted_headers,
        "host": headers.get("host", ""),
        "user_agent": headers.get("user-agent", ""),
        "content_type": headers.get("content-type", ""),
    }

    if redacted_query:
        originator["query"] = redacted_query

    if client_ip:
        originator["client_ip"] = client_ip

    if content_length := headers.get("content-length"):
        originator["content_length"] = int(content_length)

    # If we have incoming tracing context, the caller's originator_id becomes our parent_id
    if tracing_context:
        originator["parent_id"] = tracing_context["originator_id"]

    return {
        "originator": originator,
        # Use incoming trace_id if present, otherwise generate a new one
        "trace_id": tracing_context["trace_id"] if tracing_context else f"trace_{nano_id()}",
    }


def create_originator_from_flask_request(
    request: Any,
    originator_id: str | None = None,
) -> OriginatorFromRequestResult:
    """
    Create an HTTP originator from a Flask Request.

    Extracts tracing context from headers if present:
    - trace_id: extracted from x-wevt-trace-id header, or generated if not present
    - parent_id: set to the incoming x-wevt-originator header value (the caller's originator_id)

    Args:
        request: Flask Request object
        originator_id: Optional override for originator ID
    """
    headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

    # Check for incoming tracing context
    tracing_context = extract_tracing_context(headers)  # type: ignore[arg-type]

    # Get client IP
    client_ip = request.remote_addr or ""
    if forwarded := headers.get("x-forwarded-for"):
        client_ip = forwarded.split(",")[0].strip()

    # Redact sensitive data
    redacted_headers = _redact_headers(headers)
    query = request.query_string.decode() if request.query_string else None
    redacted_query = _redact_query_string(query)

    originator: HttpOriginator = {
        "originator_id": originator_id or f"orig_{nano_id()}",
        "type": "http",
        "timestamp": _now_ms(),
        "method": request.method.upper(),
        "path": request.path,
        "headers": redacted_headers,
        "host": headers.get("host", ""),
        "user_agent": headers.get("user-agent", ""),
        "content_type": headers.get("content-type", ""),
    }

    if redacted_query:
        originator["query"] = redacted_query

    if client_ip:
        originator["client_ip"] = client_ip

    if content_length := headers.get("content-length"):
        originator["content_length"] = int(content_length)

    # If we have incoming tracing context, the caller's originator_id becomes our parent_id
    if tracing_context:
        originator["parent_id"] = tracing_context["originator_id"]

    return {
        "originator": originator,
        # Use incoming trace_id if present, otherwise generate a new one
        "trace_id": tracing_context["trace_id"] if tracing_context else f"trace_{nano_id()}",
    }


def create_child_originator(
    parent: Originator, originator_type: str | None = None
) -> Originator:
    """Create a child originator from a parent (for sub-spans/child operations)"""
    return {
        "originator_id": f"orig_{nano_id()}",
        "type": originator_type or parent.get("type", "unknown"),
        "timestamp": _now_ms(),
        "parent_id": parent.get("originator_id", ""),
    }


def create_cron_originator(cron: str, job_name: str | None = None) -> CronOriginator:
    """Create a cron originator for scheduled tasks"""
    result: CronOriginator = {
        "originator_id": f"orig_{nano_id()}",
        "type": "cron",
        "timestamp": _now_ms(),
        "cron": cron,
        "scheduled_time": _now_ms(),
    }
    if job_name:
        result["job_name"] = job_name
    return result


@dataclass
class WideEventBase:
    """The base structure of a wide event"""

    event_id: str
    trace_id: str
    service: Service
    originator: Originator

    def to_dict(self) -> dict[str, Any]:
        return {
            "eventId": self.event_id,
            "traceId": self.trace_id,
            "service": dict(self.service),
            "originator": dict(self.originator),
        }


class LogCollectorClient(ABC):
    """
    Collectors adapt the log to some format and flush to an external service
    """

    @abstractmethod
    async def flush(
        self, event: WideEventBase, partials: dict[str, EventPartial]
    ) -> None:
        """Flush the wide event to the collector"""
        pass


class StdioCollector(LogCollectorClient):
    """Simple collector to log the event to stdout/console"""

    async def flush(
        self, event: WideEventBase, partials: dict[str, EventPartial]
    ) -> None:
        log_data = {
            **event.to_dict(),
            **partials,
        }
        print(json.dumps(log_data))


class CompositeCollector(LogCollectorClient):
    """Composes multiple collectors together, flushing to all of them in parallel"""

    def __init__(self, collectors: list[LogCollectorClient]):
        self._collectors = collectors

    async def flush(
        self, event: WideEventBase, partials: dict[str, EventPartial]
    ) -> None:
        await asyncio.gather(*[c.flush(event, partials) for c in self._collectors])


# Type alias for filter functions
EventFilter = Callable[[WideEventBase, dict[str, EventPartial]], bool]


class FilteredCollector(LogCollectorClient):
    """Wraps a collector and only flushes events that pass the filter function"""

    def __init__(self, collector: LogCollectorClient, filter_fn: EventFilter):
        self._collector = collector
        self._filter = filter_fn

    async def flush(
        self, event: WideEventBase, partials: dict[str, EventPartial]
    ) -> None:
        if self._filter(event, partials):
            await self._collector.flush(event, partials)


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
        self, event: WideEventBase, partials: dict[str, EventPartial]
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
        if self._flush_task is not None:
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


# Generic type for the registry
R = TypeVar("R", bound=dict[str, EventPartial])


class WideEvent(Generic[R]):
    """
    Core WideEvent class

    Args:
        service: Service that the wide event is being emitted on
        originator: Originator (i.e. request, schedule, etc) of the wide event
        collector: Location to collect/flush logs to
        trace_id: Optional trace ID (for continuing an existing trace). If not provided, a new one is generated.
    """

    def __init__(
        self,
        service: Service,
        originator: Originator,
        collector: LogCollectorClient,
        trace_id: str | None = None,
    ):
        self.event_id = f"evt_{nano_id()}"
        self.trace_id = trace_id or f"trace_{nano_id()}"
        self._service = service
        self._originator = originator
        self._collector = collector
        self._partials: dict[str, EventPartial] = {}

    def partial(self, partial: EventPartial) -> None:
        """
        Add a partial to a wide event

        Args:
            partial: wide event partial to add
        """
        partial_type = partial.get("type")
        if partial_type:
            self._partials[partial_type] = partial

    def log(self, partial: EventPartial) -> None:
        """
        Add a partial to a wide event (alias for partial)

        Args:
            partial: wide event partial to add
        """
        self.partial(partial)

    def to_log(self) -> dict[str, Any]:
        """Get the current state of the wide event as a log object"""
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
        """Emit the full wide log"""
        event_base = WideEventBase(
            event_id=self.event_id,
            trace_id=self.trace_id,
            service=self._service,
            originator=self._originator,
        )
        await self._collector.flush(event_base, self._partials)


__all__ = [
    # Core
    "nano_id",
    "EventPartial",
    "EventFilter",
    "Service",
    "WideEventBase",
    "WideEvent",
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
    "serialize_originator",
    "deserialize_originator",
    "create_originator_headers",
    "extract_originator_from_headers",
    "create_originator_from_starlette_request",
    "create_originator_from_flask_request",
    "create_child_originator",
    "create_cron_originator",
    # Tracing helpers
    "TracingContext",
    "create_tracing_headers",
    "extract_tracing_context",
    # Collectors
    "LogCollectorClient",
    "StdioCollector",
    "CompositeCollector",
    "FilteredCollector",
    "FileCollector",
]
