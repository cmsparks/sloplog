import pytest
import tempfile
import os
import time
from sloplog import (
    wideevent,
    WideEventBase,
    EventPartial,
    Service,
    HttpOriginator,
    Originator,
    cron_originator,
    tracing_headers,
    extract_tracing_context,
    ORIGINATOR_HEADER,
    TRACE_ID_HEADER,
    TracingContext,
    _redact_headers,
    _redact_query_string,
)
from sloplog.collectors import (
    stdio_collector,
    composite_collector,
    filtered_collector,
    file_collector,
    LogCollectorClient,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class TestWideEvent:
    def test_should_create_wide_event_with_event_id(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_TESTSPAN",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/",
            "headers": {},
        }

        evt = wideevent(service, originator, collector)

        assert evt.event_id.startswith("evt_")
        assert len(evt.event_id) > 4

    def test_should_log_partials_and_retrieve_via_to_log(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service", "version": "1.0.0"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_TESTSPAN",
            "timestamp": _now_ms(),
            "method": "POST",
            "path": "/api/users",
            "headers": {"Content-Type": "application/json"},
        }

        evt = wideevent(service, originator, collector)

        evt.log({"type": "user", "id": "123", "name": "John"})
        evt.log({"type": "request", "method": "POST", "duration": 150})

        log = evt.to_log()

        assert log["service"]["name"] == "my-service"
        assert log["service"]["version"] == "1.0.0"
        assert log["originator"]["type"] == "http"
        assert log["originator"]["originator_id"] == "orig_TESTSPAN"
        assert log["user"] == {"type": "user", "id": "123", "name": "John"}
        assert log["request"] == {"type": "request", "method": "POST", "duration": 150}

    @pytest.mark.asyncio
    async def test_should_flush_event_to_collector(self):
        flushed_events: list[dict[str, object]] = []

        class TestCollector(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed_events.append({"base": event, "partials": partials})

        test_collector = TestCollector()
        service: Service = {"name": "test-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_123",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/test",
        }

        evt = wideevent(service, originator, test_collector)
        evt.log({"type": "user", "id": "user_1", "name": "Test User"})

        await evt.flush()

        assert len(flushed_events) == 1
        base_event = flushed_events[0]["base"]
        assert base_event.service["name"] == "test-service"  # type: ignore[union-attr]
        assert base_event.originator["originator_id"] == "orig_123"  # type: ignore[union-attr]
        partials_dict = flushed_events[0]["partials"]
        assert partials_dict["user"] == {  # type: ignore[index]
            "type": "user",
            "id": "user_1",
            "name": "Test User",
        }

    def test_should_allow_overwriting_partials_of_same_type(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_TESTSPAN",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/",
        }

        evt = wideevent(service, originator, collector)

        evt.log({"type": "user", "id": "123", "name": "John"})
        evt.log({"type": "user", "id": "456", "name": "Jane"})

        log = evt.to_log()

        assert log["user"] == {"type": "user", "id": "456", "name": "Jane"}

    def test_partial_and_log_methods_should_work_the_same(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_TESTSPAN",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/",
        }

        evt1 = wideevent(service, originator, collector)
        evt2 = wideevent(service, originator, collector)

        evt1.log({"type": "user", "id": "123", "name": "John"})
        evt2.partial({"type": "user", "id": "123", "name": "John"})

        assert evt1.to_log()["user"] == evt2.to_log()["user"]


class TestStdioCollector:
    def test_should_implement_log_collector_client_interface(self):
        collector = stdio_collector()

        assert hasattr(collector, "flush")
        assert callable(collector.flush)


class TestCompositeCollector:
    @pytest.mark.asyncio
    async def test_should_flush_to_all_collectors_in_parallel(self):
        flushed1: list[WideEventBase] = []
        flushed2: list[WideEventBase] = []

        class Collector1(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed1.append(event)

        class Collector2(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed2.append(event)

        composite = composite_collector([Collector1(), Collector2()])

        service: Service = {"name": "test-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_123",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/test",
        }

        evt = wideevent(service, originator, composite)
        await evt.flush()

        assert len(flushed1) == 1
        assert len(flushed2) == 1
        assert flushed1[0].event_id == flushed2[0].event_id


class TestFilteredCollector:
    @pytest.mark.asyncio
    async def test_should_only_flush_events_that_pass_filter(self):
        flushed_events: list[WideEventBase] = []

        class InnerCollector(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed_events.append(event)

        # Only allow events from "allowed-service"
        filtered = filtered_collector(
            InnerCollector(),
            lambda event, _partials: event.service.get("name") == "allowed-service",
        )

        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_123",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/test",
        }

        # This should be filtered out
        evt1 = wideevent({"name": "blocked-service"}, originator, filtered)
        await evt1.flush()

        # This should pass through
        evt2 = wideevent({"name": "allowed-service"}, originator, filtered)
        await evt2.flush()

        assert len(flushed_events) == 1
        assert flushed_events[0].service.get("name") == "allowed-service"

    @pytest.mark.asyncio
    async def test_should_have_access_to_partials_in_filter_function(self):
        flushed_events: list[WideEventBase] = []

        class InnerCollector(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed_events.append(event)

        # Only allow events with "error" partial
        filtered = filtered_collector(
            InnerCollector(),
            lambda _event, partials: "error" in partials,
        )

        service: Service = {"name": "test-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_123",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/test",
        }

        # This should be filtered out (no error partial)
        evt1 = wideevent(service, originator, filtered)
        evt1.log({"type": "user", "id": "123", "name": "John"})
        await evt1.flush()

        assert len(flushed_events) == 0


class TestFileCollector:
    @pytest.mark.asyncio
    async def test_should_buffer_events_and_flush_when_buffer_is_full(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".log") as f:
            temp_path = f.name

        try:
            collector = file_collector(temp_path, buffer_size=2)

            service: Service = {"name": "test-service"}
            originator: HttpOriginator = {
                "type": "http",
                "originator_id": "orig_123",
                "timestamp": _now_ms(),
                "method": "GET",
                "path": "/test",
            }

            evt1 = wideevent(service, originator, collector)
            await evt1.flush()

            # Buffer not full yet, nothing written
            with open(temp_path) as f:
                content = f.read()
            assert content == ""

            evt2 = wideevent(service, originator, collector)
            await evt2.flush()

            # Buffer full, should have flushed
            with open(temp_path) as f:
                content = f.read()
            assert "test-service" in content
            lines = [line for line in content.split("\n") if line]
            assert len(lines) == 2
        finally:
            os.unlink(temp_path)

    @pytest.mark.asyncio
    async def test_should_flush_remaining_buffer_on_close(self):
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".log") as f:
            temp_path = f.name

        try:
            collector = file_collector(temp_path, buffer_size=10)

            service: Service = {"name": "test-service"}
            originator: HttpOriginator = {
                "type": "http",
                "originator_id": "orig_123",
                "timestamp": _now_ms(),
                "method": "GET",
                "path": "/test",
            }

            evt = wideevent(service, originator, collector)
            await evt.flush()

            # Buffer not full yet
            with open(temp_path) as f:
                content = f.read()
            assert content == ""

            # Force flush
            await collector.close()

            with open(temp_path) as f:
                content = f.read()
            assert "test-service" in content
        finally:
            os.unlink(temp_path)


class TestOriginatorFunctions:
    def test_should_create_a_cron_originator(self):
        cron = cron_originator("*/5 * * * *", "cleanup-job")

        assert cron["originator_id"].startswith("orig_")
        assert cron["type"] == "cron"
        assert cron.get("cron") == "*/5 * * * *"
        assert cron.get("job_name") == "cleanup-job"
        assert cron["timestamp"] > 0

    def test_should_create_a_cron_originator_with_parent_id(self):
        cron = cron_originator("*/5 * * * *", "cleanup-job", parent_id="orig_parent123")

        assert cron["originator_id"].startswith("orig_")
        assert cron.get("parent_id") == "orig_parent123"


class TestSensitiveDataRedaction:
    """Tests for sensitive data redaction in HTTP originators"""

    def test_should_redact_authorization_header(self):
        headers = {
            "authorization": "Bearer secret-token-12345",
            "content-type": "application/json",
        }

        redacted = _redact_headers(headers)

        assert redacted["authorization"] == "[REDACTED]"
        assert redacted["content-type"] == "application/json"

    def test_should_redact_sensitive_query_parameters(self):
        query = "code=auth-code-123&state=abc&token=secret-token"

        redacted = _redact_query_string(query)

        assert redacted is not None
        assert "code=%5BREDACTED%5D" in redacted
        assert "token=%5BREDACTED%5D" in redacted
        assert "state=abc" in redacted

    def test_should_redact_multiple_sensitive_headers(self):
        headers = {
            "authorization": "Bearer token",
            "x-api-key": "api-key-secret",
            "cookie": "session=abc123",
            "content-type": "application/json",
        }

        redacted = _redact_headers(headers)

        assert redacted["authorization"] == "[REDACTED]"
        assert redacted["x-api-key"] == "[REDACTED]"
        assert redacted["cookie"] == "[REDACTED]"
        assert redacted["content-type"] == "application/json"

    def test_should_redact_access_token_and_refresh_token(self):
        query = "access_token=secret1&refresh_token=secret2&client_id=public"

        redacted = _redact_query_string(query)

        assert redacted is not None
        assert "access_token=%5BREDACTED%5D" in redacted
        assert "refresh_token=%5BREDACTED%5D" in redacted
        assert "client_id=public" in redacted

    def test_should_handle_empty_query(self):
        assert _redact_query_string(None) is None
        # Empty string returns falsy value (empty string)
        assert not _redact_query_string("")

    def test_should_preserve_non_sensitive_headers(self):
        headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "TestClient/1.0",
            "host": "api.example.com",
        }

        redacted = _redact_headers(headers)

        assert redacted == headers  # All headers should be preserved as-is


class TestTracingContext:
    """Tests for tracing context functionality"""

    def test_should_create_tracing_headers(self):
        context: TracingContext = {
            "trace_id": "trace_myservice123",
            "originator_id": "orig_myoriginator456",
        }

        headers = tracing_headers(context)

        assert headers[TRACE_ID_HEADER] == "trace_myservice123"
        assert headers[ORIGINATOR_HEADER] == "orig_myoriginator456"

    def test_should_extract_tracing_context_from_headers(self):
        headers: dict[str, str | list[str] | None] = {
            TRACE_ID_HEADER: "trace_test123",
            ORIGINATOR_HEADER: "orig_test456",
        }

        context = extract_tracing_context(headers)

        assert context is not None
        assert context["trace_id"] == "trace_test123"
        assert context["originator_id"] == "orig_test456"

    def test_should_return_none_when_tracing_headers_incomplete(self):
        # Missing originator header
        assert extract_tracing_context({TRACE_ID_HEADER: "trace_test"}) is None
        # Missing trace ID header
        assert extract_tracing_context({ORIGINATOR_HEADER: "orig_test"}) is None
        # Empty headers
        assert extract_tracing_context({}) is None

    def test_should_handle_case_insensitive_header_lookup(self):
        headers: dict[str, str | list[str] | None] = {
            "X-Sloplog-Trace-Id": "trace_test123",
            "X-Sloplog-Originator": "orig_test456",
        }

        context = extract_tracing_context(headers)

        assert context is not None
        assert context["trace_id"] == "trace_test123"
        assert context["originator_id"] == "orig_test456"

    def test_should_include_trace_id_in_wide_event(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_test",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/",
        }

        evt = wideevent(service, originator, collector, trace_id="trace_custom123")

        assert evt.trace_id == "trace_custom123"
        log = evt.to_log()
        assert log["traceId"] == "trace_custom123"

    def test_should_generate_trace_id_if_not_provided(self):
        collector = stdio_collector()
        service: Service = {"name": "my-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_test",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/",
        }

        evt = wideevent(service, originator, collector)

        assert evt.trace_id.startswith("trace_")

    @pytest.mark.asyncio
    async def test_should_include_trace_id_in_flushed_event(self):
        flushed_events: list[WideEventBase] = []

        class TestCollector(LogCollectorClient):
            async def flush(
                self, event: WideEventBase, partials: dict[str, EventPartial]
            ) -> None:
                flushed_events.append(event)

        test_collector = TestCollector()
        service: Service = {"name": "test-service"}
        originator: HttpOriginator = {
            "type": "http",
            "originator_id": "orig_123",
            "timestamp": _now_ms(),
            "method": "GET",
            "path": "/test",
        }

        evt = wideevent(service, originator, test_collector, trace_id="trace_flush123")
        await evt.flush()

        assert len(flushed_events) == 1
        assert flushed_events[0].trace_id == "trace_flush123"
