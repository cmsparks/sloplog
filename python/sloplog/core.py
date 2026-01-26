"""Core types for sloplog wide events."""

from dataclasses import dataclass
from typing import TypedDict, Any, Literal, cast
from importlib.metadata import PackageNotFoundError, version

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


# Import Originator type for type hints
from .originator import Originator


def _snake_to_camel(snake_str: str) -> str:
    """Convert snake_case to camelCase."""
    components = snake_str.split("_")
    return components[0] + "".join(x.title() for x in components[1:])


def _convert_keys_to_camel(obj: Any) -> Any:
    """
    Recursively convert all dict keys from snake_case to camelCase.
    Used for wire-format serialization to match TypeScript output.
    """
    if isinstance(obj, dict):
        return {_snake_to_camel(k): _convert_keys_to_camel(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_convert_keys_to_camel(item) for item in obj]
    else:
        return obj


@dataclass
class WideEventBase:
    """The base structure of a wide event (without partials)."""

    event_id: str
    trace_id: str
    service: Service
    originator: Originator

    def to_dict(self) -> dict[str, Any]:
        """Convert the base event to a dict with wire-format keys (camelCase)."""
        return {
            "eventId": self.event_id,
            "traceId": self.trace_id,
            "service": _convert_keys_to_camel(dict(self.service)),
            "originator": _convert_keys_to_camel(dict(self.originator)),
        }


__all__ = [
    "EventPartial",
    "PartialValue",
    "LogMessageLevel",
    "Service",
    "service",
    "SLOPLOG_VERSION",
    "SLOPLOG_LANGUAGE",
    "WideEventBase",
]
