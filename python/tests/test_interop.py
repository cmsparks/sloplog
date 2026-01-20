"""
Integration tests for Python/TypeScript interoperability

These tests verify that originators serialized in Python can be
deserialized in TypeScript and vice versa. The tests use known serialized
values that are also tested in the TypeScript interop tests.
"""

import pytest
from wevt import (
    serialize_originator,
    deserialize_originator,
    create_originator_headers,
    extract_originator_from_headers,
    ORIGINATOR_HEADER,
    Originator,
    HttpOriginator,
    WebSocketOriginator,
)


# Known test vectors - these exact values are also used in TypeScript tests
# to ensure cross-language compatibility
TEST_VECTORS = {
    # Simple originator
    "simple": {
        "originator": {
            "originator_id": "orig_interop_test_001",
            "type": "http",
            "timestamp": 1700000000000,
        },
    },
    # HTTP originator with full details
    "http_full": {
        "originator": {
            "originator_id": "orig_http_interop_001",
            "type": "http",
            "timestamp": 1700000000000,
            "method": "POST",
            "path": "/api/v1/users",
            "query": "page=1&limit=10",
            "host": "api.example.com",
            "user_agent": "TestClient/1.0",
            "content_type": "application/json",
            "content_length": 256,
        },
    },
    # WebSocket originator
    "websocket": {
        "originator": {
            "originator_id": "orig_ws_interop_001",
            "type": "websocket",
            "timestamp": 1700000000000,
            "session_id": "ws_session_abc123",
            "source": "client",
            "message_type": "text",
            "message_size": 1024,
        },
    },
    # Originator with parent (for tracing)
    "with_parent": {
        "originator": {
            "originator_id": "orig_child_001",
            "type": "http",
            "timestamp": 1700000000000,
            "parent_id": "orig_parent_001",
        },
    },
}


class TestSerializationFormat:
    """Test Python serialization format"""

    def test_serialize_simple_originator_to_expected_format(self):
        serialized = serialize_originator(TEST_VECTORS["simple"]["originator"])

        # Verify it's a valid base64url string (no +, /, or = padding)
        import re
        assert re.match(r'^[A-Za-z0-9_-]+$', serialized)

        # Verify we can deserialize our own output
        deserialized = deserialize_originator(serialized)
        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_interop_test_001"
        assert deserialized["type"] == "http"
        assert deserialized["timestamp"] == 1700000000000

    def test_serialize_http_originator_with_all_fields(self):
        serialized = serialize_originator(TEST_VECTORS["http_full"]["originator"])
        deserialized = deserialize_originator(serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_http_interop_001"
        assert deserialized["type"] == "http"
        assert deserialized.get("method") == "POST"
        assert deserialized.get("path") == "/api/v1/users"
        assert deserialized.get("query") == "page=1&limit=10"
        assert deserialized.get("host") == "api.example.com"
        assert deserialized.get("user_agent") == "TestClient/1.0"
        assert deserialized.get("content_type") == "application/json"
        assert deserialized.get("content_length") == 256

    def test_serialize_websocket_originator(self):
        serialized = serialize_originator(TEST_VECTORS["websocket"]["originator"])
        deserialized = deserialize_originator(serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_ws_interop_001"
        assert deserialized["type"] == "websocket"
        assert deserialized.get("session_id") == "ws_session_abc123"
        assert deserialized.get("source") == "client"
        assert deserialized.get("message_type") == "text"
        assert deserialized.get("message_size") == 1024

    def test_preserve_parent_id_in_serialization(self):
        serialized = serialize_originator(TEST_VECTORS["with_parent"]["originator"])
        deserialized = deserialize_originator(serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_child_001"
        assert deserialized.get("parent_id") == "orig_parent_001"


class TestCrossLanguageDeserializationFromTypeScript:
    """Test deserializing TypeScript-generated base64 strings"""

    def test_deserialize_simple_originator_from_typescript(self):
        # TypeScript: serializeOriginator({originatorId: "orig_interop_test_001", type: "http", timestamp: 1700000000000})
        ts_serialized = "eyJ2IjoxLCJpZCI6Im9yaWdfaW50ZXJvcF90ZXN0XzAwMSIsInQiOiJodHRwIiwidHMiOjE3MDAwMDAwMDAwMDB9"

        deserialized = deserialize_originator(ts_serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_interop_test_001"
        assert deserialized["type"] == "http"
        assert deserialized["timestamp"] == 1700000000000

    def test_deserialize_http_originator_from_typescript(self):
        # TypeScript serialized HTTP originator with full details
        ts_serialized = "eyJ2IjoxLCJpZCI6Im9yaWdfaHR0cF9pbnRlcm9wXzAwMSIsInQiOiJodHRwIiwidHMiOjE3MDAwMDAwMDAwMDAsImQiOnsibWV0aG9kIjoiUE9TVCIsInBhdGgiOiIvYXBpL3YxL3VzZXJzIiwicXVlcnkiOiJwYWdlPTEmbGltaXQ9MTAiLCJob3N0IjoiYXBpLmV4YW1wbGUuY29tIiwidXNlckFnZW50IjoiVGVzdENsaWVudC8xLjAiLCJjb250ZW50VHlwZSI6ImFwcGxpY2F0aW9uL2pzb24iLCJjb250ZW50TGVuZ3RoIjoyNTZ9fQ"

        deserialized = deserialize_originator(ts_serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_http_interop_001"
        assert deserialized["type"] == "http"
        assert deserialized.get("method") == "POST"
        assert deserialized.get("path") == "/api/v1/users"
        # Note: TypeScript uses camelCase, Python uses snake_case
        # The serialization preserves the original keys
        assert deserialized.get("userAgent") or deserialized.get("user_agent") == "TestClient/1.0"

    def test_deserialize_websocket_originator_from_typescript(self):
        # TypeScript serialized WebSocket originator
        ts_serialized = "eyJ2IjoxLCJpZCI6Im9yaWdfd3NfaW50ZXJvcF8wMDEiLCJ0Ijoid2Vic29ja2V0IiwidHMiOjE3MDAwMDAwMDAwMDAsImQiOnsic2Vzc2lvbklkIjoid3Nfc2Vzc2lvbl9hYmMxMjMiLCJzb3VyY2UiOiJjbGllbnQiLCJtZXNzYWdlVHlwZSI6InRleHQiLCJtZXNzYWdlU2l6ZSI6MTAyNH19"

        deserialized = deserialize_originator(ts_serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_ws_interop_001"
        assert deserialized["type"] == "websocket"
        # TypeScript uses camelCase
        assert deserialized.get("sessionId") or deserialized.get("session_id") == "ws_session_abc123"
        assert deserialized.get("source") == "client"

    def test_deserialize_originator_with_parent_from_typescript(self):
        # TypeScript serialized originator with parent
        ts_serialized = "eyJ2IjoxLCJpZCI6Im9yaWdfY2hpbGRfMDAxIiwidCI6Imh0dHAiLCJ0cyI6MTcwMDAwMDAwMDAwMCwicGlkIjoib3JpZ19wYXJlbnRfMDAxIn0"

        deserialized = deserialize_originator(ts_serialized)

        assert deserialized is not None
        assert deserialized["originator_id"] == "orig_child_001"
        assert deserialized.get("parent_id") == "orig_parent_001"


class TestHeaderPropagation:
    """Test header propagation between Python and TypeScript"""

    def test_create_headers_that_typescript_can_parse(self):
        originator = TEST_VECTORS["simple"]["originator"]
        headers = create_originator_headers(originator)

        assert ORIGINATOR_HEADER in headers
        assert isinstance(headers[ORIGINATOR_HEADER], str)

        # Verify the header value is valid base64url
        import re
        assert re.match(r'^[A-Za-z0-9_-]+$', headers[ORIGINATOR_HEADER])

    def test_extract_originator_from_typescript_generated_headers(self):
        # Simulate headers from a TypeScript service
        ts_headers = {
            "content-type": "application/json",
            ORIGINATOR_HEADER: "eyJ2IjoxLCJpZCI6Im9yaWdfZnJvbV90eXBlc2NyaXB0IiwidCI6Imh0dHAiLCJ0cyI6MTcwMDAwMDAwMDAwMH0",
        }

        extracted = extract_originator_from_headers(ts_headers)

        assert extracted is not None
        assert extracted["originator_id"] == "orig_from_typescript"
        assert extracted["type"] == "http"

    def test_handle_case_insensitive_header_lookup(self):
        ts_headers = {
            "Content-Type": "application/json",
            "X-Wevt-Originator": "eyJ2IjoxLCJpZCI6Im9yaWdfdGVzdCIsInQiOiJodHRwIiwidHMiOjE3MDAwMDAwMDAwMDB9",
        }

        extracted = extract_originator_from_headers(ts_headers)

        assert extracted is not None
        assert extracted["originator_id"] == "orig_test"


class TestRoundTripVerification:
    """Test round-trip serialization"""

    def test_survive_python_to_base64_to_python_round_trip(self):
        original = TEST_VECTORS["http_full"]["originator"]
        serialized = serialize_originator(original)
        deserialized = deserialize_originator(serialized)

        assert deserialized["originator_id"] == original["originator_id"]
        assert deserialized["type"] == original["type"]
        assert deserialized["timestamp"] == original["timestamp"]
        assert deserialized.get("method") == original.get("method")
        assert deserialized.get("path") == original.get("path")

    def test_output_serialized_values_for_typescript_tests(self):
        """Output serialized values that can be used in TypeScript interop tests"""
        print("\n=== Serialized values for TypeScript interop tests ===")
        print("Simple:", serialize_originator(TEST_VECTORS["simple"]["originator"]))
        print("HTTP Full:", serialize_originator(TEST_VECTORS["http_full"]["originator"]))
        print("WebSocket:", serialize_originator(TEST_VECTORS["websocket"]["originator"]))
        print("With Parent:", serialize_originator(TEST_VECTORS["with_parent"]["originator"]))
        print("=================================================\n")

        # This test always passes - it's just for generating test data
        assert True


class TestInvalidData:
    """Test handling of invalid data"""

    def test_return_none_for_invalid_serialized_data(self):
        assert deserialize_originator("invalid") is None
        assert deserialize_originator("") is None

    def test_return_none_for_wrong_version(self):
        # Version 2 doesn't exist
        import base64
        import json
        wrong_version = base64.urlsafe_b64encode(
            json.dumps({"v": 2, "id": "test", "t": "http", "ts": 0}).encode()
        ).decode().rstrip("=")
        assert deserialize_originator(wrong_version) is None
