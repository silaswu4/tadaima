import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan } from "../fixtures/demo-room";

const base = process.env.E2E_BASE ?? "http://localhost:3009", origin = new URL(base).origin;
async function call(path: string, method = "GET", body?: unknown, cookie?: string, token?: string, requestOrigin = origin) {
  return fetch(base + path, { method, headers: { Origin: requestOrigin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(process.env.E2E_BYPASS ? { "x-vercel-protection-bypass": process.env.E2E_BYPASS } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("Fetch uses the browser's actual canonical room, sends fitting previews back, and sees only screen-confirmed basket changes", async () => {
  const plan = structuredClone(demoPlan); plan.items = [];
  plan.constraints = { budget: null, minimumSeats: null, clearance: 0.1 };
  const registered = await call("/api/room-sessions", "POST", { roomId: `fetch-http-${crypto.randomUUID()}`, plan });
  assert.equal(registered.status, 200, await registered.clone().text());
  const cookie = registered.headers.get("set-cookie")!.split(";")[0];
  const { plan: canonical } = await registered.json(), id = canonical.projectId;
  const pairingPath = `/api/room-sessions/${id}/fetch`, projectPath = `/api/projects/${id}`;
  assert.equal((await call(pairingPath, "POST")).status, 404);
  assert.equal((await call(pairingPath, "POST", undefined, cookie, undefined, "https://foreign.example")).status, 403);
  const minted = await call(pairingPath, "POST", undefined, cookie).then((response) => response.json());
  const attempts = await Promise.all(["sender_http_A", "sender_http_B"].map((sender) => call("/api/agent/pairings/redeem", "POST", { code: minted.code, sender })));
  assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 404]);
  const binding = await attempts.find((response) => response.status === 200)!.json();
  assert.equal(binding.projectId, id);
  const read = await call(projectPath, "GET", undefined, undefined, binding.token).then((response) => response.json());
  assert.deepEqual(read.plan.geometry, canonical.geometry);
  assert.equal(read.plan.revision, canonical.revision);
  assert.deepEqual(read.plan.evidence, []);
  assert.equal((await call(`/api/viz/${id}/r${canonical.revision}.png`)).status, 404);
  assert.equal((await call("/api/projects/proj_demo", "GET", undefined, undefined, binding.token)).status, 404);
  assert.equal((await call(projectPath + "/place", "POST", {}, undefined, binding.token)).status, 403);
  assert.equal((await call(projectPath + "/checkout", "GET", undefined, undefined, binding.token)).status, 403);
  const shopping = await call(projectPath + "/shop", "POST", { category: "chair", spot: { position: [2, 0, 2] }, maxPriceUsd: 200, live: false }, undefined, binding.token);
  assert.equal(shopping.status, 200, await shopping.clone().text());
  const job = await shopping.json(), product = job.output.results.find((result: { fits: boolean }) => result.fits)?.product;
  assert.ok(product, "fixture must return at least one fitting chair");
  const preview = await call("/api/agent/pairings/preview", "POST", { productId: product.id, jobId: job.id }, undefined, binding.token);
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.equal((await preview.json()).reviewRequired, true);
  const inbox = await call(pairingPath, "GET", undefined, cookie).then((response) => response.json());
  assert.equal(inbox.job.id, job.id); assert.equal(inbox.preview.productId, product.id);
  const before = await call("/api/agent/pairings/cart", "GET", undefined, undefined, binding.token).then((response) => response.json());
  assert.equal(before.cart.merchants.length, 0);
  // Only the owning browser can confirm placement. Fetch then reads the same basket.
  const confirmed = await call(projectPath + "/place", "POST", { productId: product.id, jobId: job.id, spot: job.output.request.spot, expectedRevision: canonical.revision }, cookie).then((response) => response.json());
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const after = await call("/api/agent/pairings/cart", "GET", undefined, undefined, binding.token).then((response) => response.json());
  assert.equal(after.cart.planRevision, confirmed.plan.revision);
  assert.equal(after.cart.merchants[0].lines[0].productId, product.id);
  assert.equal(after.cart.subtotal.amountMinor, product.price.amountMinor);
  assert.equal((await call(pairingPath, "DELETE", undefined, cookie)).status, 200);
  assert.equal((await call(projectPath, "GET", undefined, undefined, binding.token)).status, 401);
  assert.equal((await call(projectPath, "GET", undefined, cookie)).status, 200);
});
