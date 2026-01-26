"""Sentry collector for sloplog."""

import logging
from typing import Callable, Protocol, Any, Union, runtime_checkable

from ..core import PartialValue, WideEventBase, LogMessageLevel
from .base import LogCollectorClient, flatten_object


# Re-export LogMessageLevel as SentryLogLevel for API compatibility
SentryLogLevel = LogMessageLevel


@runtime_checkable
class SentryLogger(Protocol):
    """
    Protocol for Sentry's logger API (sentry_sdk.logger).

    Sentry's logger provides methods for each log level that accept
    a message string and keyword attributes.
    """

    def trace(self, message: str, **attributes: Any) -> None: ...
    def debug(self, message: str, **attributes: Any) -> None: ...
    def info(self, message: str, **attributes: Any) -> None: ...
    def warning(self, message: str, **attributes: Any) -> None: ...
    def error(self, message: str, **attributes: Any) -> None: ...
    def fatal(self, message: str, **attributes: Any) -> None: ...


def _build_summary_message(event: WideEventBase) -> str:
    """
    Build a summary message for a wide event.

    Format: [WideEvent] eventId:{id} service:{serviceName} originator:{originatorType} {httpDetails}
    """
    parts: list[str] = ["[WideEvent]"]

    # Event ID
    parts.append(f"eventId:{event.event_id}")

    # Service name
    if event.service and event.service.get("name"):
        parts.append(f"service:{event.service['name']}")

    # Originator type and details
    originator = event.originator
    if originator:
        originator_type = originator.get("type", "unknown")
        parts.append(f"originator:{originator_type}")

        # For HTTP originators, include method and path
        if originator_type == "http":
            method = originator.get("method")
            path = originator.get("path")
            if method and path:
                parts.append(f"{method} {path}")

    return " ".join(parts)


class SentryCollector(LogCollectorClient):
    """
    Collector that sends events to Sentry Logs via the Sentry logger API.

    Uses sentry_sdk.logger directly, so regular Python logging is not affected.
    Only events explicitly sent through this collector will appear in Sentry Logs.

    Generates a summary message with event ID, service name, and originator details.
    For HTTP originators, includes method and path.

    Attributes are flattened to dot-notation keys for better queryability
    in Sentry (e.g., `error.0.message`, `spans.0.name`).
    """

    def __init__(
        self,
        logger: Union[
            "SentryLogger", Callable[[], Union["SentryLogger", None]], None
        ] = None,
        level: LogMessageLevel = "info",
        level_selector: Union[
            Callable[[WideEventBase, dict[str, PartialValue]], LogMessageLevel], None
        ] = None,
        flatten_attributes: bool = True,
    ):
        """
        Initialize the Sentry collector.

        Args:
            logger: Sentry logger instance (e.g., sentry_sdk.logger) or a function
                that returns it. Using a getter function allows lazy initialization
                (e.g., waiting for sentry_sdk.init()). If None, imports sentry_sdk.logger.
            level: Default log level for events (default: "info")
            level_selector: Optional function to derive log level per event
            flatten_attributes: If True, flatten nested attributes to dot-notation
                keys for better queryability in Sentry. Default: True
        """
        if logger is None:
            # Default to sentry_sdk.logger
            self._get_logger = self._default_get_logger
        elif callable(logger) and not isinstance(logger, SentryLogger):
            self._get_logger = logger
        else:
            self._get_logger = lambda: logger  # type: ignore[return-value]

        self._level = level
        self._level_selector = level_selector
        self._flatten_attributes = flatten_attributes

    def _default_get_logger(self) -> SentryLogger | None:
        """Default logger getter that imports sentry_sdk.logger."""
        try:
            from sentry_sdk import logger as sentry_logger

            return sentry_logger  # type: ignore[return-value]
        except ImportError:
            return None

    def _is_sentry_logger(self, logger: Any) -> bool:
        module = getattr(logger, "__module__", "")
        cls_module = getattr(getattr(logger, "__class__", None), "__module__", "")
        name = getattr(logger, "__name__", "")
        return "sentry_sdk.logger" in f"{module} {cls_module} {name}"

    def _log_with_attributes(
        self,
        logger: Any,
        level: LogMessageLevel,
        message: str,
        attributes: dict[str, Any],
    ) -> None:
        # Map warn/trace to standard logging levels if needed
        method_name = (
            "warning" if level == "warn" else "debug" if level == "trace" else level
        )
        log_method = getattr(logger, method_name, None)
        if log_method is None:
            return

        if isinstance(logger, logging.Logger):
            log_method(message, extra=attributes)
            return

        if self._is_sentry_logger(logger):
            try:
                log_method(message, attributes=attributes)
                return
            except TypeError:
                try:
                    log_method(message, **attributes)
                    return
                except TypeError:
                    return

        try:
            log_method(message, **attributes)
        except TypeError:
            try:
                log_method(message, attributes=attributes)
            except TypeError:
                return

    async def flush(
        self, event: WideEventBase, partials: dict[str, PartialValue]
    ) -> None:
        logger = self._get_logger()
        if logger is None:
            return

        combined = {
            **event.to_dict(),
            **partials,
        }

        # Flatten nested attributes to dot-notation for better Sentry queryability
        attributes = flatten_object(combined) if self._flatten_attributes else combined

        level = (
            self._level_selector(event, partials)
            if self._level_selector is not None
            else self._level
        )

        # Build summary message
        message = _build_summary_message(event)

        # Call the appropriate logger method based on level
        self._log_with_attributes(logger, level, message, attributes)


def sentry_collector(
    logger: Union[
        "SentryLogger", Callable[[], Union["SentryLogger", None]], None
    ] = None,
    level: LogMessageLevel = "info",
    level_selector: Union[
        Callable[[WideEventBase, dict[str, PartialValue]], LogMessageLevel], None
    ] = None,
    flatten_attributes: bool = True,
) -> SentryCollector:
    """
    Create a collector that sends events via Sentry's logger API.

    This uses sentry_sdk.logger directly, so regular Python logging is not
    affected. Only events sent through this collector appear in Sentry Logs.

    Args:
        logger: Sentry logger instance (e.g., sentry_sdk.logger) or a function
            that returns it. If None, automatically imports sentry_sdk.logger.
        level: Default log level for events (default: "info")
        level_selector: Optional function to derive log level per event
        flatten_attributes: If True, flatten nested attributes to dot-notation
            keys for better queryability in Sentry. Default: True

    Example:
        # Simple usage - automatically uses sentry_sdk.logger
        collector = sentry_collector()

        # With explicit logger
        from sentry_sdk import logger as sentry_logger
        collector = sentry_collector(logger=sentry_logger)

        # With lazy initialization (useful if sentry_sdk.init() is called later)
        collector = sentry_collector(logger=lambda: sentry_sdk.logger)
    """
    return SentryCollector(
        logger=logger,
        level=level,
        level_selector=level_selector,
        flatten_attributes=flatten_attributes,
    )
