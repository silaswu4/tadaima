import assert from "node:assert/strict";
import test from "node:test";
import { makeWorkspaceDemo } from "../room/workspace-fixture.ts";
import { createWalkRevisionTracker } from "../room/walk-revision.ts";

test("only canonical edits advance revisions; repeated notifications and source revision fields do not", () => {
  const plan = makeWorkspaceDemo(), track = createWalkRevisionTracker(plan);
  const start = plan.revision;
  assert.equal(track.accept(structuredClone(plan)), start);
  plan.revision = 100;
  assert.equal(track.accept(plan), start);
  plan.items[0].position[0] += .2;
  assert.equal(track.accept(plan), start + 1);
  assert.equal(track.accept(plan), start + 1);
  plan.items[0].rotationY += .4;
  assert.equal(track.accept(plan), start + 2);
  plan.items[0].stored = true;
  assert.equal(track.accept(plan), start + 3);
  plan.items[0].stored = false;
  assert.equal(track.accept(plan), start + 4);
  plan.items.pop();
  assert.equal(track.accept(plan), start + 5);
});

test("undo changes still advance the revision instead of reusing an old revision", () => {
  const plan = makeWorkspaceDemo(), before = structuredClone(plan), track = createWalkRevisionTracker(plan);
  plan.items.splice(0, 1);
  assert.equal(track.accept(plan), before.revision + 1);
  assert.equal(track.accept(before), before.revision + 2);
  assert.equal(track.accept(before), before.revision + 2);
});

test("lock/unlock of in-room and stored drafts are distinct revisions while the source remains immutable", () => {
  const source = makeWorkspaceDemo(), original = structuredClone(source);
  const draft = structuredClone(source), track = createWalkRevisionTracker(draft);
  draft.items[0].locked = !draft.items[0].locked;
  assert.equal(track.accept(draft), source.revision + 1);
  assert.equal(track.accept(draft), source.revision + 1);
  draft.items[0].stored = true;
  assert.equal(track.accept(draft), source.revision + 2);
  draft.items[0].locked = !draft.items[0].locked;
  assert.equal(track.accept(draft), source.revision + 3);
  assert.deepEqual(source, original);
});
