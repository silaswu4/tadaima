import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { checkoutClient, CheckoutRequestError } from "@/backend/checkout/client";

test("checkout client sends explicit exact-cart approval with same-origin credentials", async () => {
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => { calls.push({ url, init }); return Response.json({ id: "mdt_response" }); });
  try {
    const client = checkoutClient("room / private");
    assert.equal(calls.length, 0, "constructing the client makes no payment request");
    await client.approve("exact_digest", "pm_selected");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/projects/room%20%2F%20private/checkout/approve");
    assert.equal(calls[0].init?.credentials, "same-origin");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { cartDigest: "exact_digest", paymentMethodId: "pm_selected" });
    assert.ok(!calls.some((call) => String(call.url).endsWith("/execute")));
    await client.execute();
    assert.equal(calls[1].url, "/api/projects/room%20%2F%20private/checkout/execute");
  } finally { fetchMock.mock.restore(); }
});

test("checkout propagates request cancellation and server refusal without inventing success", async () => {
  const controller = new AbortController();
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    return Response.json({ error: "cart changed; review it again" }, { status: 409 });
  });
  try {
    await assert.rejects(checkoutClient("room").get(controller.signal), (error: unknown) => error instanceof CheckoutRequestError && error.status === 409 && /cart changed/.test(error.message));
  } finally { fetchMock.mock.restore(); }
});

test("checkout client refuses unreadable or empty success responses", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("not JSON", { status: 200 }));
  try { await assert.rejects(checkoutClient("room").get(), /unreadable response/); }
  finally { fetchMock.mock.restore(); }
});
