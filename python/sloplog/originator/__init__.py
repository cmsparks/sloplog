"""
Originator module - functions for creating originators from various sources
"""

import random
import string
import time
from typing import TypedDict, Any, Literal


def nano_id() -> str:
    """Generate a nano ID for unique identifiers"""
    chars = string.ascii_letters + string.digits + "-_"
    return "".join(random.choice(chars) for _ in range(21))


def _now_ms() -> int:
    """Get current time in milliseconds"""
    return int(time.time() * 1000)


# HTTP method types
HttpMethod = Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]


class _OriginatorRequired(TypedDict):
    """Required originator fields"""

    originator_id: str  # Unique identifier for this originator chain
    type: str  # Type discriminator
    timestamp: int  # Unix timestamp in milliseconds


class Originator(_OriginatorRequired, total=False):
    """
    Base originator interface - an external thing that triggered your service.
    This is like a trace that can cross service boundaries.
    """

    parent_id: str  # Parent originator ID if this is a child span


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


# Header name for propagating originator ID across services
ORIGINATOR_HEADER = "x-sloplog-originator"
# Header name for propagating trace ID across services
TRACE_ID_HEADER = "x-sloplog-trace-id"


class TracingContext(TypedDict):
    """Tracing context to propagate across services"""

    trace_id: str  # The trace ID (stays constant across the entire distributed trace)
    originator_id: str  # The originator ID of the calling service (becomes parent_id in the callee)


def tracing_headers(context: TracingContext) -> dict[str, str]:
    """Create headers for propagating tracing context to downstream services"""
    return {
        TRACE_ID_HEADER: context["trace_id"],
        ORIGINATOR_HEADER: context["originator_id"],
    }


def extract_tracing_context(
    headers: dict[str, str | list[str] | None],
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


def starlette_http_originator(
    request: Any,
    originator_id: str | None = None,
    parent_id: str | None = None,
) -> OriginatorFromRequestResult:
    """
    Create an HTTP originator from a Starlette/FastAPI Request.

    Extracts tracing context from headers if present:
    - trace_id: extracted from x-sloplog-trace-id header, or generated if not present
    - parent_id: set to the incoming x-sloplog-originator header value (the caller's originator_id),
      or can be explicitly provided via the parent_id parameter

    Args:
        request: Starlette Request object
        originator_id: Optional override for originator ID
        parent_id: Optional explicit parent originator ID (for child originators)
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

    # Determine parent_id: explicit parameter > tracing context > None
    effective_parent_id = parent_id or (
        tracing_context["originator_id"] if tracing_context else None
    )

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

    # Set parent_id if we have one
    if effective_parent_id:
        originator["parent_id"] = effective_parent_id

    return {
        "originator": originator,
        # Use incoming trace_id if present, otherwise generate a new one
        "trace_id": tracing_context["trace_id"]
        if tracing_context
        else f"trace_{nano_id()}",
    }


def flask_http_originator(
    request: Any,
    originator_id: str | None = None,
    parent_id: str | None = None,
) -> OriginatorFromRequestResult:
    """
    Create an HTTP originator from a Flask Request.

    Extracts tracing context from headers if present:
    - trace_id: extracted from x-sloplog-trace-id header, or generated if not present
    - parent_id: set to the incoming x-sloplog-originator header value (the caller's originator_id),
      or can be explicitly provided via the parent_id parameter

    Args:
        request: Flask Request object
        originator_id: Optional override for originator ID
        parent_id: Optional explicit parent originator ID (for child originators)
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

    # Determine parent_id: explicit parameter > tracing context > None
    effective_parent_id = parent_id or (
        tracing_context["originator_id"] if tracing_context else None
    )

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

    # Set parent_id if we have one
    if effective_parent_id:
        originator["parent_id"] = effective_parent_id

    return {
        "originator": originator,
        # Use incoming trace_id if present, otherwise generate a new one
        "trace_id": tracing_context["trace_id"]
        if tracing_context
        else f"trace_{nano_id()}",
    }


def cron_originator(
    cron: str, job_name: str | None = None, parent_id: str | None = None
) -> CronOriginator:
    """
    Create a cron originator for scheduled tasks.

    Args:
        cron: Cron expression (e.g., "0 0 * * *")
        job_name: Optional name of the scheduled job
        parent_id: Optional parent originator ID (for child originators)
    """
    result: CronOriginator = {
        "originator_id": f"orig_{nano_id()}",
        "type": "cron",
        "timestamp": _now_ms(),
        "cron": cron,
        "scheduled_time": _now_ms(),
    }
    if job_name:
        result["job_name"] = job_name
    if parent_id:
        result["parent_id"] = parent_id
    return result


__all__ = [
    # ID generation
    "nano_id",
    # Types
    "Originator",
    "HttpOriginator",
    "HttpMethod",
    "WebSocketOriginator",
    "CronOriginator",
    "TracingContext",
    "OriginatorFromRequestResult",
    # Constants
    "ORIGINATOR_HEADER",
    "TRACE_ID_HEADER",
    # Functions
    "starlette_http_originator",
    "flask_http_originator",
    "cron_originator",
    "tracing_headers",
    "extract_tracing_context",
    # Private but exposed for testing
    "_redact_headers",
    "_redact_query_string",
]
