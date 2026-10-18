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
  const result = { product, fits: true, withinBudget: true, overBudgetUsd: null, problems: [], placement: { roomId: plan.geometry.rooms[0].id, position: [1, 0, 1], rotationY: 0 }, source: "catalog" };
  const job = { id: "search-1", projectId: plan.projectId, stage: "Catalog search finished", output: { live: "skipped" } };
  const state = { plan, selectedId: null, job, results: [result], proposal }, calls = [];
  const tools = createRoomAgentTools({ projectId: plan.projectId, active: () => active, context: () => state,
    refresh: async () => { calls.push("refresh"); }, propose: async (intent) => { calls.push(["propose", intent]); return proposal; },
    apply: async (id) => { calls.push(["apply", id]); }, proposal: () => state.proposal, setBudget: async (minor) => { calls.push(["budget", minor]); },
    // a search finishes its catalog pass at once
    search: async (input) => { calls.push(["search", input]); state.job = { ...job, id: "search-2" }; }, preview: (r) => { calls.push(["preview", r]); return true; },
    place: async (r) => { calls.push(["place", r]); },
    spot: () => ({ position: [1, 0, 1] }), move: async (...args) => { calls.push(["move", ...args]); }, store: async (...args) => { calls.push(["store", ...args]); }, liveSearch: false });
  return { tools, state, calls, result, proposal, stop: () => { active = false; } };
}
test("voice applies only the proposal on screen after a yes, and never pays", async () => {
  const { tools, calls, proposal, state } = voiceFixture();
  assert.match(await tools.apply_proposal({ proposal_id: "fake" }), /Not completed.*gone/);
  assert.match(await tools.pay_now({}), /Not paid/);
  assert.match(await tools.recheck_cart({}), /Not rechecked/);
  assert.deepEqual(calls, []);
  assert.match(await tools.apply_proposal({ proposal_id: proposal.id }), /^ok/);
  assert.deepEqual(calls, [["apply", proposal.id]]);
  state.proposal = null;
  assert.match(await tools.apply_proposal({}), /Not completed/);
});
test("voice searches answer with the catalog results and reject malformed inputs", async () => {
  const { tools, calls } = voiceFixture();
  for (const params of [{ category: "spaceship" }, { category: "chair", max_price_usd: NaN }, { category: "chair", max_price_usd: -1 }, { category: "chair", style: "x".repeat(301) }]) assert.match(await tools.shop_here(params), /Not completed/);
  assert.deepEqual(calls, []);
  const said = await tools.shop_here({ category: "chair", max_price_usd: 200, live: true });
  assert.match(said, /saved catalog/i);
  assert.match(said, /1\)/, "names the results");
  assert.equal(calls[0][1].live, false);
});
test("voice placing needs current results, a valid integer and a verified fit, and never guesses budget math", async () => {
  const { tools, state, calls, result } = voiceFixture();
  for (const params of [{ choice: 0 }, { choice: 1.5 }, { choice: 1, job_id: "old-search" }]) assert.match(await tools.place_product(params), /Not completed/);
  state.results[0] = { ...result, fits: false };
  assert.match(await tools.place_product({ choice: 1 }), /Not completed/);
  state.plan.constraints.budget = { amountMinor: 150000, currency: "USD" };
  state.results[0] = { ...result, withinBudget: false, overBudgetUsd: 196.97 };
  assert.match(await tools.place_product({ choice: 1 }), /Not placed.*\$197 over.*\$1,700.*set_budget with 1700/);
  assert.deepEqual(calls, []);
  state.results[0] = result;
  assert.match(await tools.place_product({ choice: 1 }), /^ok: .* in the room and the basket/);
  assert.deepEqual(calls, [["place", result]]);
});
test("voice moves locked pieces only with an explicit unlock, after asking", async () => {
  const { tools, state, calls } = voiceFixture();
  const item = state.plan.items[0]; item.locked = true;
  assert.match(await tools.move_here({ item_id: item.id }), /Not moved.*locked.*unlock true/);
  assert.match(await tools.put_away({ item_id: item.id }), /Not put away.*locked/);
  assert.deepEqual(calls, []);
  assert.match(await tools.move_here({ item_id: item.id, unlock: true }), /^ok: moved/);
  assert.match(await tools.put_away({ item_id: item.id, unlock: true }), /^ok: .* put away/);
  assert.deepEqual(calls.map((c) => [c[0], c.at(-1)]), [["move", true], ["store", true]]);
});
test("set_budget takes whole dollars and refuses nonsense", async () => {
  const { tools, calls } = voiceFixture();
  for (const usd of [0, -5, NaN, "lots"]) assert.match(await tools.set_budget({ usd }), /Not completed/);
  assert.match(await tools.set_budget({ usd: 1700 }), /^ok: .*\$1,700/);
  assert.deepEqual(calls, [["budget", 170000]]);
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
