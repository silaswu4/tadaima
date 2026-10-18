import assert from "node:assert/strict";
import test from "node:test";
import { roomXRActions, roomXRProducts, roomXRSearch, roomXRVoiceActions } from "../rooms/xr-actions.ts";

test("the scrollable catalog keeps later and Fetch previews reachable within its data bound", () => {
  const results = Array.from({ length: 30 }, (_, i) => ({ product: { id: `piece-${i}` }, fits: i > 0, source: "catalog" }));
  const visible = roomXRProducts(results, null);
  assert.equal(visible.length, 24);
  assert.equal(visible[0].product.id, "piece-1");
  const pinned = roomXRProducts(results, results[29].product);
  assert.equal(pinned.length, 24);
  assert.equal(pinned.at(-1).product.id, "piece-29");
  assert.equal(new Set(pinned.map((entry) => entry.product.id)).size, pinned.length);
  assert.equal(roomXRProducts(results, results[1].product).length, 24);
  const fetchPreview = { id: "fetch-preview" };
  assert.deepEqual(roomXRProducts([], fetchPreview), [{ product: fetchPreview, source: undefined }]);
});

const ready = { connected: true, busy: false, pending: false, moving: false, selected: { label: "Captured chair", locked: false, stored: false } };
const enabled = (state) => roomXRActions(state).filter((action) => !action.disabled).map((action) => action.id);

test("headset presets carry exact categories without relying on React's previous category", () => {
  for (const [id, category, cap] of [["search-sofa", "sofa", 1000], ["search-chair", "chair", 300], ["search-rug", "rug", 300], ["search-lamp", "lamp", 150], ["search-table", "table", 300], ["search-storage", "storage", 500], ["search-desk", "desk", 500], ["search-bed", "bed", 1000], ["search-decor", "decor", 150]]) {
    assert.deepEqual(roomXRSearch(id, "Target"), { category, maxPriceUsd: cap, merchant: "Target", live: false });
  }
  for (const id of ["unlock", "pay", "chair", "search-spaceship"]) assert.equal(roomXRSearch(id, "IKEA"), null);
});
test("the room exposes all catalog categories without an unlock, checkout or screen-panel action", () => {
  const actions = roomXRActions(ready);
  assert.equal(actions.length, 12);
  assert.equal(new Set(actions.map((action) => action.id)).size, 12);
  assert.deepEqual(enabled(ready), ["search-sofa", "search-chair", "search-rug", "search-lamp", "search-table", "search-storage", "search-desk", "search-bed", "search-decor", "rotate-selected", "store-selected"]);
});
test("locked, stored or missing selection cannot be rotated or stored", () => {
  for (const selected of [null, { ...ready.selected, locked: true }, { ...ready.selected, stored: true }]) {
    const actions = roomXRActions({ ...ready, selected });
    assert.ok(actions.find((action) => action.id === "rotate-selected").disabled);
    assert.ok(actions.find((action) => action.id === "store-selected").disabled);
  }
  assert.match(roomXRActions({ ...ready, selected: { ...ready.selected, locked: true } }).find((action) => action.id === "rotate-selected").detail, /Locked.*exit VR/);
});
test("offline, saving or moving disables all canonical changes", () => {
  for (const extra of [{ connected: false }, { busy: true }, { moving: true }]) assert.deepEqual(enabled({ ...ready, ...extra }), []);
});
test("a preview can be explicitly cancelled while item edits stay disabled", () => {
  assert.deepEqual(enabled({ ...ready, pending: true }), ["search-sofa", "search-chair", "search-rug", "search-lamp", "search-table", "search-storage", "search-desk", "search-bed", "search-decor", "cancel-preview"]);
  assert.deepEqual(enabled({ ...ready, pending: true, busy: true }), []);
});

test("VR voice requires the configured capability and starts with no open microphone", () => {
  for (const available of [false, true]) {
    const actions = roomXRVoiceActions({ available, connected: false, listening: false, status: "Talk" });
    assert.equal(actions.find((a) => a.id === "voice-toggle").disabled, !available);
    assert.equal(actions.find((a) => a.id === "voice-stop").disabled, true);
  }
});
test("VR can end a pending connection or working voice session without waiting on shopping", () => {
  for (const state of [
    { connected: false, listening: true, status: "Connecting" },
    { connected: false, listening: false, status: "Connecting" },
    { connected: true, listening: false, status: "Working" },
    { connected: true, listening: false, status: "Speaking" },
  ]) {
    const actions = roomXRVoiceActions({ available: true, ...state });
    assert.equal(actions.find((a) => a.id === "voice-stop").disabled, false);
  }
  const actions = roomXRVoiceActions({ available: true, connected: true, listening: true, status: "Listening" });
  assert.equal(actions.find((a) => a.id === "voice-toggle").label, "Send to agent");
});
