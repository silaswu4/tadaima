import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPreviewResponse } from "./local-preview";

test("private USB preview: explicit dev config, token, loopback, allowlist and non-symlink files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tadaima-preview-"));
  const token = "b".repeat(64);
  const config = { mode: "development", directory, token };
  const req = (host = "localhost", auth = `Bearer ${token}`) => new Request(`http://${host}:3017/api/local-capture/scene`, { headers: { authorization: auth } });
  try {
    await writeFile(join(directory, "scene.json"), '{"private":true}');
    const good = await localPreviewResponse(req(), "scene", config);
    assert.equal(good.status, 200);
    assert.equal(await good.text(), '{"private":true}');
    assert.match(good.headers.get("cache-control")!, /no-store/);
    assert.equal((await localPreviewResponse(req(), "scene", { ...config, mode: "production" })).status, 404);
    assert.equal((await localPreviewResponse(req(), "scene", { ...config, token: undefined })).status, 404);
    assert.equal((await localPreviewResponse(req("localhost", "Bearer nope"), "scene", config)).status, 404);
    assert.equal((await localPreviewResponse(req("example.com"), "scene", config)).status, 404);
    assert.equal((await localPreviewResponse(req(), "../scene.json", config)).status, 404);
    assert.equal((await localPreviewResponse(req("localhost", "Bearer " + "é".repeat(64)), "scene", config)).status, 404);
    await symlink(join(directory, "scene.json"), join(directory, "scene.glb"));
    assert.equal((await localPreviewResponse(req(), "model", config)).status, 404);
    const foreign = req(); foreign.headers.set("origin", "https://example.com");
    assert.equal((await localPreviewResponse(foreign, "scene", config)).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
