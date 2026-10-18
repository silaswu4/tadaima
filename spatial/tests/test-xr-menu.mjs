import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createXRMenu, XR_MENU_WIDTH, XR_MENU_HEIGHT } from "../room/workspace-xr-menu.ts";

function fixture(documentOverrides = {}) {
  let draws = 0;
  const fontsUsed = [];
  const context = new Proxy({ clearRect() { draws++; }, fillText() { fontsUsed.push(this.font); }, measureText(text) { return { width: text.length * 15 }; } }, { get: (target, key) => key in target ? target[key] : () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }), ...documentOverrides };
  const calls = [];
  const menu = createXRMenu({ onPreviewOffer: (id) => calls.push(["preview", id]), onConfirmOffer: () => calls.push(["confirm"]), onAction: (id) => calls.push(["action", id]), onLocomotionToggle: () => calls.push(["locomotion"]), onExit: () => calls.push(["exit"]), onClose: () => calls.push(["close"]) });
  const state = { offers: [{ id: "sku:chair", label: "Chair", detail: "$99 · IKEA · catalog" }], actions: ["search-chair", "search-rug", "search-lamp", "rotate-selected", "store-selected", "cancel-preview"].map((id) => ({ id, label: id })), basketLabel: "Basket 0 · $0.00", selectedItemLabel: "Your chair", status: "Choose a piece." };
  menu.setState(state, "walk");
  const uv = (id) => { const target = menu.targets.find((item) => item.id === id); assert.ok(target, id); return new THREE.Vector2((target.x + target.width / 2) / XR_MENU_WIDTH, 1 - (target.y + target.height / 2) / XR_MENU_HEIGHT); };
  return { menu, state, calls, uv, draws: () => draws, fontsUsed };
}

test("site fonts repaint the existing texture after loading and never repaint a disposed menu", async () => {
  const loaded = [], finish = [];
  const documentFonts = {
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (name) => name === "--font-display" ? '"Display Test"' : '"Body Test"' }) },
    fonts: { load: (font) => { loaded.push(font); return new Promise((resolve) => finish.push(resolve)); } },
  };
  const { menu, draws, fontsUsed } = fixture(documentFonts), texture = menu.mesh.material.map, before = draws();
  assert.ok(fontsUsed.some((font) => font.includes('"Body Test"')));
  assert.ok(fontsUsed.some((font) => font.includes('"Display Test"')));
  assert.equal(loaded.length, 3);
  finish.splice(0).forEach((resolve) => resolve([]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(draws(), before + 1); assert.equal(menu.mesh.material.map, texture); menu.dispose();
  const closed = fixture(documentFonts); closed.menu.dispose(); const lastDraw = closed.draws();
  finish.forEach((resolve) => resolve([]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed.draws(), lastDraw);
});

test("VR menu has one stable texture, large contained targets and no redraw for unchanged visible content or hover", () => {
  const { menu, state, uv, draws } = fixture();
  assert.equal(menu.mesh.geometry.parameters.width, 1.04);
  for (const target of menu.targets) { assert.ok(target.height >= 90); assert.ok(target.x >= 0 && target.y >= 0 && target.x + target.width <= XR_MENU_WIDTH && target.y + target.height <= XR_MENU_HEIGHT); }
  const geometry = menu.mesh.geometry, texture = menu.mesh.material.map, before = draws();
  menu.setState({ ...state }, "walk"); menu.setState({ ...state, selectedItemLabel: "Different hidden selection" }, "teleport");
  assert.equal(draws(), before);
  menu.setHovered([uv("preview:sku:chair")]); const hovered = draws(); assert.ok(hovered > before);
  menu.setHovered([uv("preview:sku:chair")]); assert.equal(draws(), hovered);
  assert.equal(menu.mesh.geometry, geometry); assert.equal(menu.mesh.material.map, texture); menu.dispose();
});

test("product preview is distinct from confirmation, and colon-containing product IDs remain intact", () => {
  const { menu, state, calls, uv } = fixture();
  menu.activate(uv("preview:sku:chair")); assert.deepEqual(calls, [["preview", "sku:chair"]]);
  assert.ok(!menu.targets.some((target) => target.id === "confirm"));
  menu.setState({ ...state, pendingOfferId: "sku:chair", canConfirm: true }, "walk");
  menu.activate(uv("tab-controls")); assert.equal(menu.activeTab, "controls");
  menu.activate(uv("confirm")); menu.activate(uv("action:cancel-preview"));
  assert.deepEqual(calls, [["preview", "sku:chair"], ["confirm"], ["action", "cancel-preview"]]); menu.dispose();
});

test("locked edits and busy actions are disabled while close and tabs remain usable", () => {
  const { menu, state, calls, uv } = fixture();
  menu.setState({ ...state, selectedItemLocked: true }, "walk"); menu.activate(uv("tab-room"));
  menu.activate(uv("action:rotate-selected")); menu.activate(uv("action:store-selected")); assert.deepEqual(calls, []);
  menu.setState({ ...state, busy: true, pendingOfferId: "sku:chair", canConfirm: true }, "walk");
  assert.equal(menu.activeTab, "shop"); menu.activate(uv("confirm")); menu.activate(uv("action:search-chair"));
  menu.activate(uv("tab-controls")); menu.activate(uv("locomotion")); assert.deepEqual(calls, []);
  menu.activate(uv("close")); assert.deepEqual(calls, [["close"]]); menu.dispose();
});

test("foreign and hidden pending offers cannot enable confirmation, and cancel requires an available action", () => {
  const { menu, state, calls, uv } = fixture();
  menu.setState({ ...state, pendingOfferId: "foreign", canConfirm: true }, "walk");
  assert.ok(!menu.targets.some((target) => target.id === "confirm"));
  menu.setState({ ...state, pendingOfferId: "sku:chair", canConfirm: true, actions: [] }, "walk");
  menu.activate(uv("action:cancel-preview")); assert.deepEqual(calls, []);
  menu.setState({ ...state, offers: Array.from({ length: 10 }, (_, i) => ({ id: `sku${i}`, label: "Chair" })), pendingOfferId: "sku9", canConfirm: true }, "walk");
  assert.ok(!menu.targets.some((target) => target.id === "confirm")); menu.dispose();
});

test("invalid/background UVs do not activate anything and menu resources dispose exactly once", () => {
  const { menu, calls } = fixture();
  for (const uv of [new THREE.Vector2(NaN, .5), new THREE.Vector2(-1, .5), new THREE.Vector2(.5, 2), new THREE.Vector2(.01, .01)]) menu.activate(uv);
  assert.deepEqual(calls, []);
  const resources = [menu.mesh.geometry, menu.mesh.material, menu.mesh.material.map], disposed = [];
  resources.forEach((resource, i) => resource.addEventListener("dispose", () => disposed.push(i)));
  menu.dispose(); menu.dispose(); menu.activate(new THREE.Vector2(.5, .5));
  assert.deepEqual(disposed.sort(), [0, 1, 2]); assert.equal(menu.targets.length, 0);
});
