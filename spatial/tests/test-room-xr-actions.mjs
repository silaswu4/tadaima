import assert from "node:assert/strict";
import test from "node:test";
import { roomXRActions, roomXRProducts, roomXRSearch } from "../rooms/xr-actions.ts";

test("the active preview stays in the three VR products, including Fetch and later results", () => {
  const results = Array.from({ length: 5 }, (_, i) => ({ product: { id: `piece-${i}` }, fits: i > 0, source: "catalog" }));
  assert.deepEqual(roomXRProducts(results, null).map((entry) => entry.product.id), ["piece-1", "piece-2", "piece-3"]);
  assert.deepEqual(roomXRProducts(results, results[4].product).map((entry) => entry.product.id), ["piece-1", "piece-2", "piece-4"]);
  assert.equal(roomXRProducts(results, results[1].product).length, 3);
  const fetchPreview = { id: "fetch-preview" };
  assert.deepEqual(roomXRProducts([], fetchPreview), [{ product: fetchPreview, source: undefined }]);
});

const ready = { connected: true, busy: false, pending: false, moving: false, selected: { label: "Captured chair", locked: false, stored: false } };
const enabled = (state) => roomXRActions(state).filter((action) => !action.disabled).map((action) => action.id);

test("headset presets carry exact categories without relying on React's previous category", () => {
  for (const [id, category, cap] of [["search-chair", "chair", 300], ["search-rug", "rug", 300], ["search-lamp", "lamp", 150]]) {
    assert.deepEqual(roomXRSearch(id, "Target"), { category, maxPriceUsd: cap, merchant: "Target", live: false });
  }
  for (const id of ["unlock", "pay", "chair", "search-table"]) assert.equal(roomXRSearch(id, "IKEA"), null);
});
test("the room has six bounded controls without an unlock, checkout or screen-panel action", () => {
  const actions = roomXRActions(ready);
  assert.equal(actions.length, 6);
  assert.equal(new Set(actions.map((action) => action.id)).size, 6);
  assert.deepEqual(enabled(ready), ["search-chair", "search-rug", "search-lamp", "rotate-selected", "store-selected"]);
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
  assert.deepEqual(enabled({ ...ready, pending: true }), ["search-chair", "search-rug", "search-lamp", "cancel-preview"]);
  assert.deepEqual(enabled({ ...ready, pending: true, busy: true }), []);
});
