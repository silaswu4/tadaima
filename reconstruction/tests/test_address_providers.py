"""Provider protocol tests; no network, credentials, or paid calls."""

import base64
import io
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

from reconstruction.address import providers as p


SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False, "required": []}
RUN_ID = "c9c60563-f4ef-4c84-a910-efecad3cfa77"


class BrowserUseProviderTests(unittest.TestCase):
    def test_v4_sequence_schema_and_output_not_session_metadata(self):
        responses = [
            {"id": RUN_ID, "status": "queued", "liveUrl": "secret-browser-url"},
            {"status": "running"}, {"status": "completed"},
            {"id": RUN_ID, "status": "completed", "output": {"sources": []}, "liveUrl": "secret-browser-url"},
        ]
        with patch.object(p, "_request_json", side_effect=responses) as request, patch.object(p.time, "sleep"):
            result = p.BrowserUseResearchProvider("test-key", model="test-model").research("research", SCHEMA)
        self.assertEqual(result, {"sources": []})
        calls = request.call_args_list
        self.assertEqual(calls[0].args[:2], ("POST", "https://api.browser-use.com/api/v4/runs"))
        self.assertEqual(calls[0].args[2], {"X-Browser-Use-API-Key": "test-key"})
        self.assertEqual(calls[0].args[3], {"task": "research", "outputSchema": SCHEMA, "maxCostUsd": 2, "model": "test-model"})
        self.assertTrue(calls[1].args[1].endswith(f"/{RUN_ID}/status"))
        self.assertTrue(calls[3].args[1].endswith(f"/{RUN_ID}"))
        self.assertEqual(sum(c.args[0] == "POST" for c in calls), 1)

    def test_model_omitted_by_default_and_string_json_output_supported(self):
        with patch.object(p, "_request_json", side_effect=[
            {"id": RUN_ID, "status": "completed"},
            {"id": RUN_ID, "status": "completed", "output": '{"sources": []}'},
        ]) as request:
            self.assertEqual(p.BrowserUseResearchProvider("key").research("task", SCHEMA), {"sources": []})
        self.assertNotIn("model", request.call_args_list[0].args[3])

    def test_failed_cancelled_runs_are_not_successes(self):
        for status in ["failed", "cancelled"]:
            with self.subTest(status=status), patch.object(p, "_request_json", return_value={"id": RUN_ID, "status": status}) as request:
                with self.assertRaisesRegex(p.ProviderError, status):
                    p.BrowserUseResearchProvider("key").research("task", SCHEMA)
                self.assertEqual(request.call_count, 1)

    def test_no_duplicate_create_on_transport_failure(self):
        with patch.object(p, "_request_json", side_effect=p.ProviderError("transport failed")) as request:
            with self.assertRaises(p.ProviderError):
                p.BrowserUseResearchProvider("key").research("task", SCHEMA)
        self.assertEqual(request.call_count, 1)

    def test_timeout_cancels_known_run(self):
        with patch.object(p, "_request_json", side_effect=[{"id": RUN_ID, "status": "running"}, {}]) as request, patch.object(p.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(p.ProviderError, "deadline"):
                p.BrowserUseResearchProvider("key", timeout_seconds=1).research("task", SCHEMA)
        self.assertEqual(request.call_args_list[-1].args[:2], ("POST", f"https://api.browser-use.com/api/v4/runs/{RUN_ID}/cancel"))

    def test_poll_failure_and_cancellation_failure_preserve_sanitized_error(self):
        with patch.object(p, "_request_json", side_effect=[
            {"id": RUN_ID, "status": "running"}, p.ProviderError("poll unavailable"), p.ProviderError("cancel unavailable"),
        ]) as request, patch.object(p.time, "sleep"):
            with self.assertRaisesRegex(p.ProviderError, "poll unavailable"):
                p.BrowserUseResearchProvider("key").research("task", SCHEMA)
        self.assertTrue(request.call_args_list[-1].args[1].endswith("/cancel"))

    def test_unknown_status_cancels(self):
        for status in ["paused", [], {}, None]:
            with self.subTest(status=status), patch.object(p, "_request_json", side_effect=[{"id": RUN_ID, "status": status}, {}]) as request:
                with self.assertRaisesRegex(p.ProviderError, "unknown"):
                    p.BrowserUseResearchProvider("key").research("task", SCHEMA)
            self.assertTrue(request.call_args_list[-1].args[1].endswith("/cancel"))

    def test_malformed_run_id_never_interpolated_into_endpoint(self):
        for bad in [None, "../secret", "https://evil.example", "not-a-uuid", 7]:
            with self.subTest(bad=bad), patch.object(p, "_request_json", return_value={"id": bad, "status": "running"}) as request:
                with self.assertRaisesRegex(p.ProviderError, "invalid run ID"):
                    p.BrowserUseResearchProvider("key").research("task", SCHEMA)
                self.assertEqual(request.call_count, 1)

    def test_missing_invalid_or_mismatched_output_rejected(self):
        for result in [
            {"id": RUN_ID, "status": "completed", "output": None},
            {"id": RUN_ID, "status": "completed", "output": "not-json"},
            {"id": RUN_ID, "status": "completed", "output": []},
            {"id": RUN_ID, "status": "completed", "output": '{"x":NaN}'},
            {"id": "different", "status": "completed", "output": {}},
        ]:
            with self.subTest(result=result), patch.object(p, "_request_json", side_effect=[{"id": RUN_ID, "status": "completed"}, result]):
                with self.assertRaises(p.ProviderError):
                    p.BrowserUseResearchProvider("key").research("task", SCHEMA)

    def test_invalid_configuration_before_network(self):
        for kwargs in [{"api_key": ""}, {"api_key": "bad\nkey"}, {"api_key": "key", "max_cost_usd": 0}, {"api_key": "key", "timeout_seconds": float("inf")}, {"api_key": "key", "model": ""}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(p.ProviderError):
                p.BrowserUseResearchProvider(**kwargs)


class OpenAIProviderTests(unittest.TestCase):
    def response(self, text='{"geometry": null}'):
        return {"status": "completed", "output": [{"type": "reasoning"}, {"type": "message", "content": [{"type": "output_text", "text": text}]}]}

    def test_actual_image_and_pdf_bytes_in_responses_payload(self):
        assets = [{"id": "plan", "mediaType": "application/pdf", "body": b"%PDF-test"}, {"id": "photo", "mediaType": "image/jpeg", "body": b"image-bytes"}]
        with patch.object(p, "_request_json", return_value=self.response()) as request:
            self.assertEqual(p.OpenAIGeometryProvider("key", "vision-model").extract("grounded geometry", assets, SCHEMA), {"geometry": None})
        method, url, headers, payload = request.call_args.args
        self.assertEqual((method, url), ("POST", "https://api.openai.com/v1/responses"))
        self.assertEqual(headers, {"Authorization": "Bearer key"})
        self.assertIs(payload["store"], False)
        self.assertEqual(payload["model"], "vision-model")
        self.assertEqual(payload["max_output_tokens"], 16000)
        self.assertEqual(payload["text"]["format"], {"type": "json_schema", "name": "room_geometry_proposal", "strict": True, "schema": SCHEMA})
        content = payload["input"][0]["content"]
        file_part = next(x for x in content if x["type"] == "input_file")
        image_part = next(x for x in content if x["type"] == "input_image")
        self.assertEqual(file_part["filename"], "plan.pdf")
        self.assertEqual(file_part["file_data"], "data:application/pdf;base64," + base64.b64encode(b"%PDF-test").decode())
        self.assertEqual(image_part["image_url"], "data:image/jpeg;base64," + base64.b64encode(b"image-bytes").decode())
        self.assertEqual(image_part["detail"], "high")
        self.assertTrue(any(x.get("text") == "Evidence asset ID: photo" for x in content))

    def test_all_documented_image_media_types(self):
        for media in ["image/png", "image/jpeg", "image/webp", "image/gif"]:
            with self.subTest(media=media), patch.object(p, "_request_json", return_value=self.response()):
                p.OpenAIGeometryProvider("key", "model").extract("task", [{"id": "a", "mediaType": media, "body": b"bytes"}], SCHEMA)

    def test_incomplete_refusal_missing_text_malformed_are_failures(self):
        for response in [
            {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
            {"status": "failed", "error": {"message": "private-key"}},
            {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "private-text"}]}]},
            {"status": "completed", "output": []},
            {"status": "completed", "output": None},
            self.response("[]"), self.response("not-json"), self.response('{"x": Infinity}'),
        ]:
            with self.subTest(response=response), patch.object(p, "_request_json", return_value=response):
                with self.assertRaises(p.ProviderError) as caught:
                    p.OpenAIGeometryProvider("private-key", "model").extract("task", [], SCHEMA)
                self.assertNotIn("private", str(caught.exception))

    def test_assets_rejected_before_network(self):
        for assets in [
            [{"id": "a", "mediaType": "text/html", "body": b"html"}],
            [{"id": "a", "mediaType": {}, "body": b"html"}],
            [{"id": "../a", "mediaType": "image/png", "body": b"bytes"}],
            [{"id": "a", "mediaType": "image/png", "body": "https://example.com/photo"}],
            [{"id": "a", "mediaType": "image/png", "body": b""}],
            [{"id": "a", "mediaType": "image/png", "body": b"bytes"}] * 2,
            [{"id": str(i), "mediaType": "image/png", "body": b"x"} for i in range(9)],
            [{"id": str(i), "mediaType": "application/pdf", "body": b"x"} for i in range(3)],
            [{"id": "a", "mediaType": "image/png", "body": b"x" * (32 * 1024 * 1024 + 1)}],
        ]:
            with self.subTest(count=len(assets)), patch.object(p, "_request_json") as request:
                with self.assertRaises(p.ProviderError):
                    p.OpenAIGeometryProvider("key", "model").extract("task", assets, SCHEMA)
                request.assert_not_called()

    def test_explicit_model_and_positive_integer_tokens_required(self):
        for kwargs in [{"model": ""}, {"model": "model", "max_output_tokens": 0}, {"model": "model", "max_output_tokens": True}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(p.ProviderError):
                p.OpenAIGeometryProvider("key", **kwargs)


class HTTPTransportTests(unittest.TestCase):
    def test_http_error_sanitizes_body_and_credential(self):
        error = urllib.error.HTTPError("https://api.example", 401, "private-key", {}, io.BytesIO(b"private-key private prompt"))
        with patch.object(p.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = error
            with self.assertRaisesRegex(p.ProviderError, "status 401") as caught:
                p._request_json("POST", "https://api.example", {"Authorization": "private-key"}, {})
        self.assertNotIn("private", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_transport_error_does_not_echo_exception(self):
        with patch.object(p.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.URLError("private-key")
            with self.assertRaises(p.ProviderError) as caught:
                p._request_json("GET", "https://api.example", {})
        self.assertNotIn("private", str(caught.exception))

    def test_no_redirect_handler(self):
        self.assertIsNone(p._NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://evil.example"))

    def test_response_size_and_json_limits(self):
        for raw in [b"bad json", b"[]", b'{"a": NaN}', b"x" * (8 * 1024 * 1024 + 1)]:
            with self.subTest(size=len(raw)), patch.object(p.urllib.request, "build_opener") as factory:
                response = Mock()
                response.read.return_value = raw
                factory.return_value.open.return_value.__enter__.return_value = response
                with self.assertRaises(p.ProviderError):
                    p._request_json("GET", "https://api.example", {})


if __name__ == "__main__":
    unittest.main()
