import assert from "node:assert/strict";
import test from "node:test";
import { demoPlan } from "../../backend/fixtures/demo-room.ts";
import { AgentRevisionConflict, applyRoomProposal, requestRoomProposal } from "../rooms/agent-operations.ts";
import { applyChanges, validateChanges } from "../../backend/plan/rules.ts";
import { createRoomAgentTools } from "../rooms/agent-tools.ts";

function fixture() {
  const plan = structuredClone(demoPlan); plan.projectId = "proj_room_agent_test";
  const cost = { knownSubtotal: { amountMinor: 10000, currency: "USD" }, unknownPriceItemIds: [], feesKnown: false };
  const proposal = { id: "proposal-1", projectId: plan.projectId, baseRevision: plan.revision, intent: "Set a budget", result: structuredClone(plan), changes: [{ kind: "set_constraints", constraints: { budget: { amountMinor: 200000, currency: "USD" } } }], validations: [], summary: "Set a budget.", costBefore: cost, costAfter: cost, createdAt: "2026-10-18T00:00:00Z" };
  return { plan, proposal };
}
test("text request passes the trimmed intent and selected piece without editing the plan", async () => {
  const { plan, proposal } = fixture(), before = structuredClone(plan), calls = [];
  const result = await requestRoomProposal({ propose: async (...args) => { calls.push(args); return proposal; } }, plan, "  Set a $2000 budget  ", plan.items[0].id);
  assert.equal(result, proposal); assert.deepEqual(calls, [["Set a $2000 budget", plan.items[0].id]]); assert.deepEqual(plan, before);
});
test("empty, oversized and stale selected-item requests stop before calling a provider", async () => {
  const { plan } = fixture(); let calls = 0;
  const client = { propose: async () => { calls++; } };
  for (const [text, id] of [[" ", null], ["x".repeat(501), null], ["Move this", "gone"]]) await assert.rejects(requestRoomProposal(client, plan, text, id));
  assert.equal(calls, 0);
});
test("foreign and stale proposal responses never reach review as valid proposals", async () => {
  const { plan, proposal } = fixture();
  await assert.rejects(requestRoomProposal({ propose: async () => ({ ...proposal, projectId: "other" }) }, plan, "Set budget", null), /another room/);
  await assert.rejects(requestRoomProposal({ propose: async () => ({ ...proposal, result: { ...plan, projectId: "other" } }) }, plan, "Set budget", null), /another room/);
  await assert.rejects(requestRoomProposal({ propose: async () => ({ ...proposal, baseRevision: plan.revision + 1 }) }, plan, "Set budget", null), AgentRevisionConflict);
});
test("apply refuses another room, changed revision, empty and failed proposals before any write", async () => {
  const { plan, proposal } = fixture(); let calls = 0;
  const client = { apply: async () => { calls++; } };
  for (const candidate of [{ ...proposal, projectId: "other" }, { ...proposal, baseRevision: -1 }, { ...proposal, changes: [] }, { ...proposal, validations: [{ status: "fail", message: "No room" }] }]) await assert.rejects(applyRoomProposal(client, plan, candidate));
  assert.equal(calls, 0);
});
test("apply returns only the server's accepted plan and propagates revision/validation refusal", async () => {
  const { plan, proposal } = fixture(), accepted = { ...plan, revision: plan.revision + 1 };
  assert.equal(await applyRoomProposal({ apply: async (p) => { assert.equal(p, proposal); return { ok: true, plan: accepted }; } }, plan, proposal), accepted);
  await assert.rejects(applyRoomProposal({ apply: async () => ({ ok: false, reason: "stale_revision", currentRevision: 8 }) }, plan, proposal), AgentRevisionConflict);
  await assert.rejects(applyRoomProposal({ apply: async () => ({ ok: false, reason: "validation_failed", validations: [{ status: "fail", message: "Blocked" }] }) }, plan, proposal), /Blocked/);
});

function voiceFixture() {
  const { plan, proposal } = fixture(); let active = true;
  const product = plan.products[0];
  const result = { product, fits: true, withinBudget: true, problems: [], placement: { roomId: plan.geometry.rooms[0].id, position: [1, 0, 1], rotationY: 0 }, source: "catalog" };
  const job = { id: "search-1", projectId: plan.projectId, stage: "Catalog search finished", output: { live: "skipped" } };
  const state = { plan, selectedId: null, job, results: [result] }, calls = [];
  const tools = createRoomAgentTools({ projectId: plan.projectId, active: () => active, context: () => state,
    refresh: async () => { calls.push("refresh"); }, propose: async (intent) => { calls.push(["propose", intent]); return proposal; },
    search: async (input) => { calls.push(["search", input]); }, preview: (r) => { calls.push(["preview", r]); return true; },
    spot: () => ({ position: [1, 0, 1] }), move: async (...args) => { calls.push(["move", ...args]); }, store: async (...args) => { calls.push(["store", ...args]); }, liveSearch: false });
  return { tools, state, calls, result, proposal, stop: () => { active = false; } };
}
test("voice cannot approve proposals or execute payments", async () => {
  const { tools, calls } = voiceFixture();
  assert.match(await tools.apply_proposal({ proposal_id: "fake" }), /Not applied.*on screen/);
  assert.match(await tools.pay_now({}), /Not paid/);
  assert.match(await tools.recheck_cart({}), /Not rechecked/);
  assert.deepEqual(calls, []);
});
test("voice searches report catalog limits and reject malformed inputs", async () => {
  const { tools, calls } = voiceFixture();
  for (const params of [{ category: "spaceship" }, { category: "chair", max_price_usd: NaN }, { category: "chair", max_price_usd: -1 }, { category: "chair", style: "x".repeat(301) }]) assert.match(await tools.shop_here(params), /Not completed/);
  assert.deepEqual(calls, []);
  assert.match(await tools.shop_here({ category: "chair", max_price_usd: 200, live: true }), /saved catalog/);
  assert.equal(calls[0][1].live, false);
});
test("voice preview requires current room results, a valid integer and a verified fit", async () => {
  const { tools, state, calls, result } = voiceFixture();
  for (const params of [{ choice: 0 }, { choice: 1.5 }, { choice: 1, job_id: "old-search" }]) assert.match(await tools.place_product(params), /Not completed/);
  state.results[0] = { ...result, fits: false };
  assert.match(await tools.place_product({ choice: 1 }), /Not completed/);
  assert.deepEqual(calls, []);
  state.results[0] = result;
  assert.match(await tools.place_product({ choice: 1 }), /Previewing.*Not placed/);
  assert.deepEqual(calls, [["preview", result]]);
});
test("voice cannot override locked pieces even when the agent asks to unlock", async () => {
  const { tools, state, calls } = voiceFixture();
  const item = state.plan.items[0]; item.locked = true;
  assert.match(await tools.move_here({ item_id: item.id, unlock: true }), /unlock it on screen/);
  assert.match(await tools.put_away({ item_id: item.id, unlock: true }), /unlock it on screen/);
  assert.deepEqual(calls, []);
  item.locked = false;
  assert.match(await tools.move_here({ item_id: item.id }), /^ok: moved/);
  assert.match(await tools.put_away({ item_id: item.id }), /^ok: put/);
  assert.equal(calls.length, 2);
});
test("late tools and cross-room context cannot read or mutate another room", async () => {
  for (const stop of [true, false]) {
    const value = voiceFixture(); if (stop) value.stop(); else value.state.plan.projectId = "another-room";
    for (const tool of Object.values(value.tools)) assert.match(await tool({}), /Not completed.*session has ended/);
    assert.deepEqual(value.calls, []);
  }
});


test("pre-existing scan overlap does not block a non-worsening budget proposal", async () => {
  const { plan, proposal } = fixture();
  plan.items[1].position = [...plan.items[0].position];
  proposal.result = applyChanges(plan, proposal.changes);
  proposal.validations = validateChanges(plan, proposal.changes, proposal.result);
  assert.ok(proposal.validations.some((check) => check.status === "fail" && check.rule === "no_overlap"));
  let called = false;
  const result = await applyRoomProposal({ apply: async () => { called = true; return { ok: true, plan: { ...proposal.result, revision: plan.revision + 1 } }; } }, plan, proposal);
  assert.equal(called, true); assert.equal(result.revision, plan.revision + 1);
});
