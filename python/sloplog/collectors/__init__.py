"""
Collector exports for sloplog.

Collectors are split into separate modules to allow importing only the ones
you need without requiring all dependencies. For example, if you don't use
Sentry, you don't need to have the Sentry SDK installed.

Usage:
    # Import specific collectors
    from sloplog.collectors import StdioCollector, stdio_collector
    from sloplog.collectors.sentry import SentryCollector, sentry_collector
    from sloplog.collectors.betterstack import BetterStackCollector, betterstack_collector

    # Or import base types
    from sloplog.collectors import LogCollectorClient, EventFilter
"""

# Base types and utilities - always available
from .base import (
    LogCollectorClient,
    EventFilter,
    CompositeCollector,
    FilteredCollector,
    composite_collector,
    filtered_collector,
    flatten_object,
    truncate_stack,
    MAX_STACK_LINES,
)

# Stdio collector - no external dependencies
from .stdio import StdioCollector, stdio_collector

__all__ = [
    # Base types
    "LogCollectorClient",
    "EventFilter",
    # Utilities
    "flatten_object",
    "truncate_stack",
    "MAX_STACK_LINES",
    # Core collectors (no external deps)
    "CompositeCollector",
    "FilteredCollector",
    "StdioCollector",
    # Factory functions
    "composite_collector",
    "filtered_collector",
    "stdio_collector",
]
