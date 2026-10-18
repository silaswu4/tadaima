# Address research provider protocols

Verified against primary documentation on October 17, 2026. These adapters are server-only, standard-library HTTP clients. No browser keys, SDK packages, or credentials belong in client bundles.

## Browser Use Cloud API V4

`BrowserUseResearchProvider(api_key, timeout_seconds=240, max_cost_usd=2, model=None).research(task, output_schema)` creates one run and returns only its structured `output` object. It sends `X-Browser-Use-API-Key` without a Bearer prefix, `task`, `outputSchema`, and positive `maxCostUsd`. An explicit `model` is optional; omission uses the provider's account/default behavior, which can change.

The implementation follows the current [OpenAPI V4 schema](https://docs.browser-use.com/cloud/openapi/v4.json):

1. [`POST /api/v4/runs`](https://docs.browser-use.com/cloud/api-v4/runs/create-run.md).
2. [`GET /api/v4/runs/{id}/status`](https://docs.browser-use.com/cloud/api-v4/runs/get-run-status.md) at bounded two-second intervals, rather than repeatedly retrieving full output.
3. After `completed`, [`GET /api/v4/runs/{id}`](https://docs.browser-use.com/cloud/api-v4/runs/get-run.md) once to obtain structured output.
4. On timeout, interrupted polling, or protocol failure after a valid run ID is received, attempt [`POST /api/v4/runs/{id}/cancel`](https://docs.browser-use.com/cloud/api-v4/runs/cancel-run.md). Cancellation is idempotent; a cancellation failure is suppressed to preserve the original sanitized error.

`failed` and `cancelled` are terminal failures. Unknown status, malformed UUID, mismatched final run identity, missing output, and non-object structured results are errors. Session details, live browser URLs, provider error bodies, and event metadata are not returned. No create request is retried: a transport timeout can leave a paid remote run running without a returned ID. That case requires account-side reconciliation rather than a duplicate paid run. Cancellation is best effort, not a guarantee that all remote resources stopped. Browser keep-alive can still incur charges after a run completes. The run's provider cost cap is not a guarantee of an exact total invoice or a cap on subsequent OpenAI extraction costs.

The adapter does not retry HTTP 429 or transient failures. This deliberately keeps paid calls unambiguous; production queue-level retry policies must first reconcile existing runs and follow provider retry guidance. The local research timeout does not bound downstream geometry extraction or Blender generation.

## OpenAI Responses API

`OpenAIGeometryProvider(api_key, model, max_output_tokens=16000).extract(prompt, assets, output_schema)` sends downloaded evidence bytes to `POST https://api.openai.com/v1/responses`. The caller must configure a model that supports vision/PDF inputs and Structured Outputs; no model name or account availability is assumed.

- Images use `input_image` with an actual base64 data URL and `detail: "high"`. Accepted MIME types: PNG, JPEG, WebP, GIF. Image validity and supported non-animated formats should be checked by the download stage; MIME strings alone do not certify an image.
- PDFs use `input_file`, a safe `.pdf` filename, and `data:application/pdf;base64,...` in `file_data`. For vision-capable models, file processing includes extracted text and page images. See [file inputs](https://developers.openai.com/api/docs/guides/file-inputs).
- A preceding text part identifies each asset's stable evidence ID. A URL string or model description of a photo is not a substitute for its bytes.
- `text.format` is `json_schema` with `strict: true`, and `store: false` disables response storage. This setting does not imply zero retention across all provider services or Browser Use. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- Incomplete/failed status, refusal, malformed output, and missing JSON are errors; partial output never becomes accepted geometry.
- Defense-in-depth limits: eight images, two PDFs, 32 MiB total raw bytes, unique safe asset IDs, and a 240-second HTTP timeout. These are local limits, not a guarantee that any model will accept every bounded request.

Structured Outputs and successful parsing do not establish factual accuracy. The caller remains responsible for local schema and evidence validation, dimension support, exact-unit matching, safe media downloads, and review gates. The configured schema must satisfy OpenAI's strict schema subset, including required fields and `additionalProperties: false` on objects. No external URLs are fetched by this adapter.

## Verification

`python3 -m unittest reconstruction.tests.test_address_providers -v` exercises the actual request sequence and payloads with mocked HTTP transport, including cancellation, output/refusal handling, payload caps, and sanitized errors. These tests make no paid calls and do not establish live provider account access or model performance.
