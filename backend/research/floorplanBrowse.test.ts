import assert from "node:assert/strict";
import { test } from "node:test";
import { line } from "@/backend/research/floorplanBrowse";

const ev = (type: string, data: Record<string, unknown>) => ({ id: 1, type, data });

test("the browsing agent's steps come from its reasoning titles and first sentences", () => {
  assert.equal(line(ev("browser.ready", {})), "Browser open");
  assert.equal(line(ev("core.event", { type: "reasoning", part: { id: "prt_0", text: "**Opening the site**\n\nfirst" } })), "Opening the site");
  assert.equal(line(ev("core.event", { type: "reasoning", part: "{'id': 'prt_1', 'text': '**Finding floor plans link**\\n\\nI need to find it', 'time': {}}" })), "Finding floor plans link");
  assert.equal(line(ev("core.event", { type: "text", part: "{'id': 'prt_2', 'text': 'I\\u2019ll open the Atrium Westwood site. Then the plans.'}" })), "I’ll open the Atrium Westwood site.");
  assert.equal(line(ev("core.event", { type: "text", part: `{'id': 'prt_3', 'text': "It's the studio plan, 420 sq ft."}` })), "It's the studio plan, 420 sq ft.");
  assert.equal(line(ev("core.event", { type: "reasoning", part: "{'id': 'prt_4', 'text': ''}" })), null);
  assert.equal(line(ev("llm.request", { model: "x" })), null);
  assert.equal(line(ev("core.event", { type: "step_start", part: "{}" })), null);
});
