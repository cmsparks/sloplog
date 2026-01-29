"""
Built-in aggregation functions for sloplog rollups.

These functions are used to compute aggregate statistics over repeatable partials.
They match the TypeScript implementations for cross-language compatibility.

Note: avg is intentionally NOT included because it doesn't compose in two-stage
aggregation. Use sum + count and compute avg = sum/count at query time.
"""

from typing import Callable, Any
from dataclasses import dataclass
from builtins import sum as builtin_sum, min as builtin_min, max as builtin_max


@dataclass(frozen=True)
class AggFn:
    """
    An aggregation function with a name and compute function.
    Matches the TypeScript AggFn interface.
    """

    name: str
    _fn: Callable[[list[Any]], Any]

    def __call__(self, values: list[Any]) -> Any:
        return self._fn(values)


# Type alias for histogram results
HistogramResult = dict[str, int]


def _sum_fn(values: list[int | float]) -> float:
    """Sum aggregation - computes the sum of all numeric values."""
    return float(builtin_sum(values))


def _min_fn(values: list[int | float]) -> float:
    """Minimum aggregation - finds the smallest numeric value."""
    if not values:
        return 0.0
    return float(builtin_min(values))


def _max_fn(values: list[int | float]) -> float:
    """Maximum aggregation - finds the largest numeric value."""
    if not values:
        return 0.0
    return float(builtin_max(values))


def _count_fn(values: list[Any]) -> int:
    """Count aggregation - counts the number of values."""
    return len(values)


# Built-in aggregation functions (matching TypeScript exports)
sum = AggFn("sum", _sum_fn)
min = AggFn("min", _min_fn)
max = AggFn("max", _max_fn)
count = AggFn("count", _count_fn)


# Default bucket boundaries for latency histograms (in milliseconds).
# Based on Prometheus default buckets, suitable for HTTP request latencies.
DEFAULT_HISTOGRAM_BUCKETS: list[int | float] = [
    5,
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    2500,
    5000,
    10000,
]


def histogram(buckets: list[int | float] | None = None) -> AggFn:
    """
    Create a histogram aggregation function with custom bucket boundaries.

    Histograms are useful for computing percentiles in two-stage aggregation scenarios.
    Unlike raw values or exact percentiles, histogram bucket counts are additive across
    multiple events, allowing accurate percentile estimation at query time.

    The histogram uses cumulative bucket counts (Prometheus-style), where each bucket
    contains the count of all values less than or equal to that boundary.

    Args:
        buckets: List of bucket boundaries. Defaults to DEFAULT_HISTOGRAM_BUCKETS.

    Returns:
        An AggFn that computes histogram buckets.

    Example:
        >>> from sloplog import histogram, partial
        >>>
        >>> partial_metadata = {
        ...     "api_call": {
        ...         "repeatable": True,
        ...         "agg": {
        ...             "latency_ms": [sum, histogram([10, 50, 100, 250, 500])],
        ...         },
        ...     },
        ... }

    At query time, sum bucket counts across events and compute percentiles:
        SELECT
          SUM(api_call_agg_latencyMs_histogram_100) as le_100,
          SUM(api_call_agg_latencyMs_histogram_inf) as total
        FROM events
        -- Then interpolate to find p95, p99, etc.
    """
    if buckets is None:
        buckets = DEFAULT_HISTOGRAM_BUCKETS

    # Sort buckets to ensure correct cumulative counting
    sorted_buckets = sorted(buckets)

    def compute_histogram(values: list[int | float]) -> HistogramResult:
        result: HistogramResult = {}

        # Cumulative counts (Prometheus style): count of values <= boundary
        for boundary in sorted_buckets:
            result[str(boundary)] = len([v for v in values if v <= boundary])

        # Always include +Infinity bucket (total count)
        result["inf"] = len(values)

        return result

    return AggFn("histogram", compute_histogram)


__all__ = [
    "AggFn",
    "HistogramResult",
    "sum",
    "min",
    "max",
    "count",
    "histogram",
    "DEFAULT_HISTOGRAM_BUCKETS",
]
