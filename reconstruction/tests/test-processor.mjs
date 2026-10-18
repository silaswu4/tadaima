/** Node 22.18+ native TypeScript smoke test; no new application dependency. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { LocalReconstructionProcessor } from "../processor.server.ts";

const projectRoot = resolve(import.meta.dirname, "../..");
const outputRoot = await mkdtemp(join(tmpdir(), "tadaima-adapter-test-"));
try {
  assert.throws(() => new LocalReconstructionProcessor({ projectRoot: ".", outputRoot }), /absolute/);
  assert.throws(() => new LocalReconstructionProcessor({ projectRoot, outputRoot, timeoutSeconds: NaN }), /timeout/);
  const processor = new LocalReconstructionProcessor({ projectRoot, outputRoot });
  assert.throws(() => processor.getOutputDirectory({ projectId: "demo", jobId: "../../escape" }), /safe ASCII/);
  const request = JSON.parse(await readFile(join(projectRoot, "reconstruction/fixtures/living-room.request.json"), "utf8"));
  const result = await processor.generate(request);
  assert.equal(result.jobId, request.jobId);
  assert.equal(result.projectId, request.projectId);
  assert.equal(result.inputRevision, request.inputRevision);
  const saved = JSON.parse(await readFile(join(processor.getOutputDirectory(request), "manifest.json"), "utf8"));
  assert.deepEqual(result, saved);
  await assert.rejects(processor.generate(request), /already exists/);
  console.log("Node adapter verified: real Blender invocation, matching manifest, safe IDs, and no-overwrite behavior.");
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
