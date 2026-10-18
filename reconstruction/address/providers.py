"""Small, server-only HTTP adapters for public research and visual extraction.

These adapters do not certify an agent's claims. The pipeline validates output,
evidence scope, downloaded assets, and geometry before a result is accepted.
"""

from __future__ import annotations

import base64
import json
import math
import re
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


class ProviderError(RuntimeError):
    """Provider failed without exposing credentials or untrusted response bodies."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _reject_constant(value: str) -> None:
    raise ValueError("Non-finite JSON number")


def _json_object(value: Any) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value, parse_constant=_reject_constant)
        except (ValueError, TypeError):
            raise ProviderError("Provider returned malformed structured JSON") from None
    if not isinstance(value, dict):
        raise ProviderError("Provider structured output must be an object")
    return value


def _request_json(
    method: str, url: str, headers: dict, payload: dict | None = None,
    *, timeout: float = 30,
) -> dict:
    """No redirects, no automatic retries, bounded response, sanitized errors."""
    try:
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(url, data=body, method=method, headers={
            "Accept": "application/json", "Content-Type": "application/json", **headers,
        })
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ProviderError("Provider JSON response exceeded 8 MiB")
        return _json_object(raw.decode("utf-8"))
    except ProviderError:
        raise
    except urllib.error.HTTPError as exc:
        # Never surface provider bodies: they can echo prompts, URLs or keys.
        code = exc.code
        exc.close()
        raise ProviderError(f"Provider HTTP request failed (status {code})") from None
    except (OSError, ValueError, TypeError, UnicodeError):
        raise ProviderError("Provider request failed or returned invalid JSON") from None


def _credential(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        raise ProviderError("A valid provider API key is required")
    return value.strip()


def _positive_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ProviderError(f"{label} must be a positive finite number")
    return float(value)


def _validate_input(text: str, schema: dict) -> None:
    if not isinstance(text, str) or not text.strip():
        raise ProviderError("Provider task must be nonempty text")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ProviderError("Provider output schema must describe an object")


def _run_id(value: Any) -> str:
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise ProviderError("Browser Use returned an invalid run ID") from None
    return value


class BrowserUseResearchProvider:
    """Browser Use Cloud API V4, one paid run per research call."""

    _base_url = "https://api.browser-use.com/api/v4"
    _statuses = {"queued", "dispatching", "running", "completed", "failed", "cancelled"}
    _terminal = {"completed", "failed", "cancelled"}

    def __init__(self, api_key: str, timeout_seconds: float = 240,
                 max_cost_usd: float = 2, model: str | None = None):
        self._api_key = _credential(api_key)
        self.timeout_seconds = _positive_number(timeout_seconds, "Research timeout")
        self.max_cost_usd = _positive_number(max_cost_usd, "Research cost cap")
        if model is not None and (not isinstance(model, str) or not model.strip()):
            raise ProviderError("Browser Use model must be nonempty when specified")
        self.model = model

    def research(self, task: str, output_schema: dict) -> dict:
        _validate_input(task, output_schema)
        headers = {"X-Browser-Use-API-Key": self._api_key}
        payload = {"task": task, "outputSchema": output_schema, "maxCostUsd": self.max_cost_usd}
        if self.model is not None:
            payload["model"] = self.model
        deadline = time.monotonic() + self.timeout_seconds
        run_id = None
        terminal = False

        def call(method: str, path: str, data: dict | None = None) -> dict:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError("Browser Use research exceeded its deadline")
            return _request_json(method, self._base_url + path, headers, data,
                                 timeout=min(30, remaining))

        try:
            # Never retry creation: a transport timeout may leave a paid run alive.
            created = call("POST", "/runs", payload)
            run_id = _run_id(created.get("id"))
            status = created.get("status")
            while True:
                if not isinstance(status, str) or status not in self._statuses:
                    raise ProviderError("Browser Use returned an unknown run status")
                if status in self._terminal:
                    terminal = True
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProviderError("Browser Use research exceeded its deadline")
                time.sleep(min(2, remaining))
                status = call("GET", f"/runs/{run_id}/status").get("status")
            if status != "completed":
                raise ProviderError(f"Browser Use research ended with status {status}")
            result = call("GET", f"/runs/{run_id}")
            if result.get("id") != run_id or result.get("status") != "completed":
                raise ProviderError("Browser Use final response did not match the completed run")
            # Return only structured output, never live previews/session metadata.
            return _json_object(result.get("output"))
        finally:
            if run_id is not None and not terminal:
                try:
                    _request_json("POST", self._base_url + f"/runs/{run_id}/cancel",
                                  headers, timeout=10)
                except ProviderError:
                    # Best effort. No automatic replacement run or unsafe raw error.
                    pass


class OpenAIGeometryProvider:
    """Responses API with actual image/PDF bytes and strict structured output."""

    def __init__(self, api_key: str, model: str, max_output_tokens: int = 16000):
        self._api_key = _credential(api_key)
        if not isinstance(model, str) or not model.strip():
            raise ProviderError("An explicit OpenAI vision-capable model is required")
        if isinstance(max_output_tokens, bool) or not isinstance(max_output_tokens, int) or max_output_tokens <= 0:
            raise ProviderError("OpenAI output token limit must be a positive integer")
        self.model = model
        self.max_output_tokens = max_output_tokens

    def extract(self, prompt: str, assets: list[dict], output_schema: dict) -> dict:
        _validate_input(prompt, output_schema)
        if not isinstance(assets, list):
            raise ProviderError("Extraction assets must be a list")
        content = [{"type": "input_text", "text": prompt}]
        image_count = pdf_count = size = 0
        ids = set()
        for asset in assets:
            if not isinstance(asset, dict):
                raise ProviderError("Extraction asset must be an object")
            asset_id, media_type, body = asset.get("id"), asset.get("mediaType"), asset.get("body")
            if not isinstance(asset_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", asset_id) or asset_id in ids:
                raise ProviderError("Extraction asset IDs must be unique safe identifiers")
            ids.add(asset_id)
            if not isinstance(body, bytes) or not body:
                raise ProviderError("Extraction asset requires nonempty downloaded bytes")
            size += len(body)
            if size > 32 * 1024 * 1024:
                raise ProviderError("Extraction assets exceed 32 MiB")
            if isinstance(media_type, str) and media_type in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                image_count += 1
                if image_count > 8:
                    raise ProviderError("Extraction supports at most eight images")
                encoded = base64.b64encode(body).decode("ascii")
                content.extend([
                    {"type": "input_text", "text": f"Evidence asset ID: {asset_id}"},
                    {"type": "input_image", "image_url": f"data:{media_type};base64,{encoded}", "detail": "high"},
                ])
            elif media_type == "application/pdf":
                pdf_count += 1
                if pdf_count > 2:
                    raise ProviderError("Extraction supports at most two PDFs")
                encoded = base64.b64encode(body).decode("ascii")
                content.extend([
                    {"type": "input_text", "text": f"Evidence asset ID: {asset_id}"},
                    {"type": "input_file", "filename": f"{asset_id}.pdf",
                     "file_data": f"data:application/pdf;base64,{encoded}"},
                ])
            else:
                raise ProviderError("Unsupported extraction asset media type")
        response = _request_json("POST", "https://api.openai.com/v1/responses",
            {"Authorization": f"Bearer {self._api_key}"}, {
                "model": self.model, "store": False,
                "max_output_tokens": self.max_output_tokens,
                "input": [{"role": "user", "content": content}],
                "text": {"format": {"type": "json_schema", "name": "room_geometry_proposal",
                                    "strict": True, "schema": output_schema}},
            }, timeout=240)
        if response.get("status") != "completed":
            raise ProviderError("OpenAI extraction did not complete; no geometry was accepted")
        texts = []
        output = response.get("output")
        if not isinstance(output, list):
            raise ProviderError("OpenAI extraction returned no output messages")
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            parts = item.get("content")
            if not isinstance(parts, list):
                raise ProviderError("OpenAI extraction returned malformed message content")
            for part in parts:
                if not isinstance(part, dict):
                    raise ProviderError("OpenAI extraction returned malformed content")
                if part.get("type") == "refusal":
                    raise ProviderError("OpenAI refused extraction; no geometry was accepted")
                if part.get("type") == "output_text":
                    if not isinstance(part.get("text"), str):
                        raise ProviderError("OpenAI extraction returned malformed text")
                    texts.append(part["text"])
        if not texts:
            raise ProviderError("OpenAI extraction returned no structured text")
        return _json_object("".join(texts))
