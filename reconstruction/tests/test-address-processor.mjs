/** Node 22.18+ worker boundary test with an explicitly synthetic Python process. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalAddressResearchProcessor } from "../address/processor.server.ts";

const projectRoot = resolve(import.meta.dirname, "../..");
const root = await mkdtemp(join(tmpdir(), "tadaima-address-adapter-"));
try {
  const pythonPath = join(root, "synthetic python");
  await writeFile(pythonPath, `#!/usr/bin/env python3
import json
from pathlib import Path
import sys
args=sys.argv[1:]
assert args[:2] == ["-m", "reconstruction.address"]
request=json.loads(Path(args[args.index("--input")+1]).read_text())
output=Path(args[args.index("--output")+1])
output.mkdir(parents=True)
(output/"synthetic-invocation.json").write_text(json.dumps({"request":request,"args":args}))
print(json.dumps({"schemaVersion":"address-research/1.0","status":"needs_evidence",
  "projectId":request["projectId"],"jobId":"mismatch" if request.get("targetRoom")=="tamper" else request["jobId"],
  "inputRevision":request["inputRevision"],"reviewRequired":True,
  "sourceCount":0,"downloadedAssetCount":0,"dossierPath":str(output/"dossier.json"),
  "reconstructionRequestPath":None,"draftManifestPath":None}))
`);
  await chmod(pythonPath, 0o700);
  assert.throws(() => new LocalAddressResearchProcessor({ projectRoot: ".", outputRoot: root }), /absolute/);
  const processor = new LocalAddressResearchProcessor({ projectRoot, outputRoot: root, pythonPath, renderDraft: true });
  assert.throws(() => processor.getOutputDirectory({ projectId: "demo", jobId: "../escape" }), /safe ASCII/);
  const request = { projectId: "synthetic-property", jobId: "research-001", inputRevision: 42,
    address: "100 Fictional Example Street; $(not-a-shell)", unit: "201" };
  const receipt = await processor.research(request);
  assert.equal(receipt.status, "needs_evidence");
  assert.equal(receipt.inputRevision, 42);
  const invocation = JSON.parse(await readFile(join(processor.getOutputDirectory(request), "synthetic-invocation.json"), "utf8"));
  assert.deepEqual(invocation.request, request);
  assert.ok(invocation.args.includes("--render-draft"));
  assert.ok(!invocation.args.includes(request.address));
  await assert.rejects(processor.research({ ...request, jobId: "research-002", targetRoom: "tamper" }), /mismatched receipt/);
  console.log("Address Node adapter verified with a synthetic worker: private input, safe argv, identity checks, draft flag.");
} finally {
  await rm(root, { recursive: true, force: true });
}
