import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { ApiError } from "@/backend/client";
import { localRoomSnapshot, mutationMessage, registerRoom, syncRoom } from "@/backend/room-session-client";
import { makeWorkspaceDemo } from "@/spatial/room/workspace-fixture";

test("mutation refusal reports the new blockers rather than unrelated existing scan warnings", () => {
  const existing = { rule: "no_overlap" as const, status: "fail" as const, itemIds: ["owned"], message: "Existing scan overlap." };
  const blocked = { rule: "budget" as const, status: "fail" as const, itemIds: ["new"], message: "This exceeds your budget." };
  assert.equal(mutationMessage({ ok: false, reason: "validation_failed", validations: [existing, blocked], blocking: [blocked] }), blocked.message);
});

test("registration posts only the canonical room payload to the same-origin cookie session", async () => {
  const source = makeWorkspaceDemo(), before = structuredClone(source);
  const controller = new AbortController();
  const fetchMock = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "/api/room-sessions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal);
    assert.deepEqual(init?.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(init?.body as string), { roomId: "local-scan-private", plan: source });
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).has("cookie"), false, "the HttpOnly session is browser-owned");
    return Response.json({ plan: { ...source, projectId: "proj_room_registered" }, resumed: false,
      capabilities: { liveSearch: false, testPayments: false, persistence: "memory" } });
  });
  try {
    const session = await registerRoom("local-scan-private", source, controller.signal);
    assert.equal(session.plan.projectId, "proj_room_registered");
    assert.equal(session.capabilities.liveSearch, false);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.deepEqual(source, before);
  } finally { fetchMock.mock.restore(); }
});

test("sync uses the encoded server project identity and explicit expected server revision", async () => {
  const draft = makeWorkspaceDemo(); draft.projectId = "server / room?private"; draft.revision = 41;
  const before = structuredClone(draft);
  const fetchMock = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "/api/room-sessions/server%20%2F%20room%3Fprivate/sync");
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(init?.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(init?.body as string), { expectedRevision: 7, plan: draft });
    return Response.json({ ok: true, plan: { ...draft, revision: 8 } });
  });
  try {
    const result = await syncRoom(draft.projectId, 7, draft);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plan.revision, 8);
    assert.deepEqual(draft, before);
  } finally { fetchMock.mock.restore(); }
});

test("server stale or validation refusal stays a refusal instead of client-side success", async () => {
  const draft = makeWorkspaceDemo();
  const refusals = [
    { ok: false, reason: "stale_revision", currentRevision: 9 },
    { ok: false, reason: "validation_failed", validations: [{ rule: "no_overlap", status: "fail", itemIds: ["a"], message: "Choose a free floor spot." }] },
  ];
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json(refusals.shift()));
  try {
    const stale = await syncRoom("server", 7, draft);
    assert.deepEqual(stale, { ok: false, reason: "stale_revision", currentRevision: 9 });
    assert.match(mutationMessage(stale as Exclude<typeof stale, { ok: true }>), /refreshed/);
    const invalid = await syncRoom("server", 7, draft);
    assert.equal(invalid.ok, false);
    assert.equal(mutationMessage(invalid as Exclude<typeof invalid, { ok: true }>), "Choose a free floor spot.");
  } finally { fetchMock.mock.restore(); }
});

test("browser snapshot restores source identity and deep-clones every editable server field", () => {
  const server = makeWorkspaceDemo(); server.projectId = "proj_room_server"; server.revision = 19;
  const before = structuredClone(server), local = localRoomSnapshot(server, "local-roomplan");
  assert.equal(local.projectId, "local-roomplan");
  assert.equal(local.revision, 19);
  assert.deepEqual({ ...local, projectId: server.projectId }, server);
  local.items[0].position = [9, 0, 9];
  local.geometry.rooms[0].floorPolygon[0] = [9, 9];
  local.constraints.clearance = 1;
  assert.deepEqual(server, before);
});

test("an already aborted registration never issues a fetch", async () => {
  const controller = new AbortController();
  const aborted = new DOMException("The operation was aborted.", "AbortError"); controller.abort(aborted);
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("cancelled registration fetched"); });
  try {
    await assert.rejects(registerRoom("room", makeWorkspaceDemo(), controller.signal), (cause: unknown) => cause === aborted);
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally { fetchMock.mock.restore(); }
});

test("HTTP authentication failures keep status and sanitized server message", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ error: "no room session" }, { status: 404 }));
  try {
    await assert.rejects(syncRoom("server", 1, makeWorkspaceDemo()), (cause: unknown) => cause instanceof ApiError && cause.status === 404 && cause.message === "no room session");
  } finally { fetchMock.mock.restore(); }
});

test("unreadable success and non-string server errors fail clearly", async () => {
  const responses = [new Response("not JSON", { status: 200 }), Response.json(null), Response.json([]), Response.json({ error: { internal: "untrusted object" } }, { status: 503 })];
  const fetchMock = mock.method(globalThis, "fetch", async () => responses.shift()!);
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(registerRoom("room", makeWorkspaceDemo()), /unreadable response/);
    await assert.rejects(registerRoom("room", makeWorkspaceDemo()), (cause: unknown) => cause instanceof ApiError && cause.status === 503 && cause.message === "Room service returned 503.");
  } finally { fetchMock.mock.restore(); }
});


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const registrationResponse = () => Response.json({ plan: makeWorkspaceDemo(), resumed: false,
  capabilities: { liveSearch: false, testPayments: false, persistence: "memory" } });


test("concurrent registrations wait for the first response and keep their original draft snapshot", async () => {
  const firstStarted = deferred<void>(), releaseFirst = deferred<Response>();
  const sent: Array<{ roomId: string; plan: ReturnType<typeof makeWorkspaceDemo> }> = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string); sent.push(body);
    if (body.roomId === "first") { firstStarted.resolve(); return releaseFirst.promise; }
    return registrationResponse();
  });
  try {
    const first = registerRoom("first", makeWorkspaceDemo()); await firstStarted.promise;
    const secondPlan = makeWorkspaceDemo(), original = structuredClone(secondPlan);
    const second = registerRoom("second", secondPlan);
    secondPlan.items[0].locked = !secondPlan.items[0].locked;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((entry) => entry.roomId), ["first"]);
    releaseFirst.resolve(registrationResponse());
    await Promise.all([first, second]);
    assert.deepEqual(sent.map((entry) => entry.roomId), ["first", "second"]);
    assert.deepEqual(sent[1].plan, original);
  } finally { releaseFirst.resolve(registrationResponse()); fetchMock.mock.restore(); }
});

test("queued cancellation rejects promptly and never fetches while later registrations still run", async () => {
  const firstStarted = deferred<void>(), releaseFirst = deferred<Response>();
  const rooms: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const { roomId } = JSON.parse(init?.body as string); rooms.push(roomId);
    if (roomId === "held") { firstStarted.resolve(); return releaseFirst.promise; }
    return registrationResponse();
  });
  try {
    const first = registerRoom("held", makeWorkspaceDemo()); await firstStarted.promise;
    const controller = new AbortController(), cancelled = new DOMException("Room closed", "AbortError");
    const second = registerRoom("cancelled", makeWorkspaceDemo(), controller.signal);
    controller.abort(cancelled);
    await assert.rejects(second, (cause: unknown) => cause === cancelled);
    assert.deepEqual(rooms, ["held"], "cancellation does not wait for or bypass the held request");
    const third = registerRoom("third", makeWorkspaceDemo());
    releaseFirst.resolve(registrationResponse());
    await Promise.all([first, third]);
    assert.deepEqual(rooms, ["held", "third"]);
  } finally { releaseFirst.resolve(registrationResponse()); fetchMock.mock.restore(); }
});

test("supported browsers acquire an origin-scoped exclusive Web Lock before registration", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const lockStarted = deferred<void>(), releaseLock = deferred<void>();
  const controller = new AbortController();
  const calls: Array<{ name: string; options: LockOptions }> = [];
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    async request(name: string, options: LockOptions, action: () => Promise<unknown>) {
      calls.push({ name, options }); lockStarted.resolve(); await releaseLock.promise;
      return action();
    },
  } });
  const fetchMock = mock.method(globalThis, "fetch", async () => registrationResponse());
  try {
    const pending = registerRoom("cross-tab", makeWorkspaceDemo(), controller.signal);
    await lockStarted.promise;
    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(calls[0].name, "tadaima:room-session-registration");
    assert.deepEqual(calls[0].options, { mode: "exclusive", signal: controller.signal });
    releaseLock.resolve(); await pending;
    assert.equal(fetchMock.mock.calls.length, 1);
  } finally {
    releaseLock.resolve(); fetchMock.mock.restore();
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});

test("registration failures release the same-window queue for the next room", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (JSON.parse(init?.body as string).roomId === "failed") return Response.json({ error: "registration unavailable" }, { status: 503 });
    return registrationResponse();
  });
  try {
    const failed = registerRoom("failed", makeWorkspaceDemo()), next = registerRoom("next", makeWorkspaceDemo());
    await assert.rejects(failed, /registration unavailable/);
    await next;
    assert.equal(fetchMock.mock.calls.length, 2);
  } finally { fetchMock.mock.restore(); }
});

test("cancellation while waiting for another tab's lock never starts the registration fetch", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const lockStarted = deferred<void>(), releaseLock = deferred<void>(), lockFinished = deferred<void>();
  const controller = new AbortController();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    async request(_name: string, options: LockOptions, action: () => Promise<unknown>) {
      assert.equal(options.signal, controller.signal);
      lockStarted.resolve(); await releaseLock.promise;
      try { return await action(); } finally { lockFinished.resolve(); }
    },
  } });
  const fetchMock = mock.method(globalThis, "fetch", async () => registrationResponse());
  try {
    const pending = registerRoom("cancelled-cross-tab", makeWorkspaceDemo(), controller.signal);
    await lockStarted.promise; controller.abort();
    await assert.rejects(pending, (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError");
    assert.equal(fetchMock.mock.calls.length, 0);
    releaseLock.resolve(); await lockFinished.promise;
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    releaseLock.resolve(); fetchMock.mock.restore();
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
