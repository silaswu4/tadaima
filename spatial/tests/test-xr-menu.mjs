import { createXRDOMFixture, settleXRMenu } from "./xr-menu-dom-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createXRMenu, XR_MENU_WIDTH, XR_MENU_HEIGHT } from "../room/workspace-xr-menu.ts";

const categories = ["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor"];
const product = { id: "sku:chair", category: "chair", merchant: "IKEA", sourceUrl: "https://example.com/chair", variantId: "oak",
  label: "Oak chair, natural", dimensions: [.8, .9, .7], seats: 1, price: { amountMinor: 12900, currency: "USD" },
  availability: "available", imageUrl: "https://example.com/chair.jpg", observedAt: "2026-10-18T12:00:00Z", evidenceIds: [], fixture: true };

async function fixture(t, { initialTab = "shop", state: overrides, fonts } = {}) {
  const dom = createXRDOMFixture(), calls = [];
  if (fonts) Object.defineProperty(dom.document, "fonts", { configurable: true, value: fonts });
  const menu = createXRMenu({ onPreviewOffer: (id) => calls.push(["preview", id]), onConfirmOffer: () => calls.push(["confirm"]),
    onAction: (id) => calls.push(["action", id]), onLocomotionToggle: () => calls.push(["locomotion"]),
    onExit: () => calls.push(["exit"]), onClose: () => calls.push(["close"]) }, dom.runtime);
  t.after(async () => { menu.dispose(); await dom.close(); });
  const state = { offers: [{ id: product.id, label: product.label, product, fits: true, withinBudget: true, source: "catalog" }],
    actions: [...categories.map((category) => `search-${category}`), "rotate-selected", "store-selected", "cancel-preview", "voice-toggle", "voice-stop"].map((id) => ({ id, label: id })),
    basketLabel: "Basket 0 · $0.00", selectedItemLabel: "Your chair", roomLabel: "Scanned living room", status: "Choose a piece.",
    agent: { available: true, connected: true, listening: false, status: "Ready" }, ...overrides };
  menu.setState(state, "walk"); await settleXRMenu(menu);
  const uv = (id) => { const target = menu.targets.find((item) => item.id === id); assert.ok(target, `missing visible target ${id}`);
    return new THREE.Vector2((target.x + target.width / 2) / XR_MENU_WIDTH, 1 - (target.y + target.height / 2) / XR_MENU_HEIGHT); };
  const click = async (id) => { menu.activate(uv(id)); await settleXRMenu(menu); };
  if (initialTab !== "agent") await click(`tab-${initialTab}`);
  return { dom, menu, state, calls, uv, click,
    async setState(next, locomotion = "walk") { menu.setState(next, locomotion); await settleXRMenu(menu); } };
}

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("actual React catalog contains supplied product images, dimensions, price and all nine category actions", async (t) => {
  const { dom, menu, state, click, calls } = await fixture(t);
  const card = dom.document.querySelector(".room-product-card"); assert.ok(card);
  assert.equal(card.querySelector("img").getAttribute("src"), product.imageUrl);
  assert.equal(card.querySelector("img").getAttribute("crossorigin"), "anonymous");
  assert.match(card.textContent, /80 × 70 × 90 cm/); assert.match(card.textContent, /\$129\.00/);
  assert.match(card.textContent, /IKEA/); assert.match(card.textContent, /Fits here/);
  // The website's own catalog chips, one per category.
  assert.equal(dom.document.querySelectorAll(".room-x__catalog .room-x__chips [data-xr-id]").length, 9);
  assert.equal(menu.mesh.geometry.parameters.width, 1.04);
  for (const target of menu.targets) assert.ok(target.width > 0 && target.height > 0 && target.x >= 0 && target.y >= 0
    && target.x + target.width <= XR_MENU_WIDTH + 1e-8 && target.y + target.height <= XR_MENU_HEIGHT + 1e-8);
  await click("action:search-sofa"); assert.deepEqual(calls, [["action", "search-sofa"]]);
  menu.setState({ ...state, offers: [{ ...state.offers[0], product: { ...product, imageUrl: null, dimensions: null, price: null } }] }, "walk");
  await settleXRMenu(menu);
  assert.match(dom.document.body.textContent, /Image unavailable/);
  assert.match(dom.document.body.textContent, /Size not listed/); assert.match(dom.document.body.textContent, /Price unknown/);
  assert.ok(!menu.targets.some((target) => target.id.startsWith("preview:")), "unmeasured products cannot start a placement");
});

test("surface resources stay stable, identical state and repeated hover do not recapture", async (t) => {
  const { dom, menu, state, uv } = await fixture(t);
  const resources = [menu.mesh.geometry, menu.mesh.material, menu.mesh.material.map], before = dom.captures();
  menu.setState({ ...state }, "walk"); await settleXRMenu(menu); assert.equal(dom.captures(), before);
  // Hover must never rasterize: one capture blocks the Quest main thread for 60–120 ms.
  const quads = () => menu.mesh.children.filter((child) => child.name === "workspace-xr-menu-hover" && child.visible);
  menu.setHovered([uv("preview:sku:chair")]); await settleXRMenu(menu);
  assert.equal(dom.captures(), before, "hovering a button draws a highlight without recapturing the DOM");
  const target = menu.targets.find((item) => item.id === "preview:sku:chair"), [quad] = quads();
  assert.equal(quads().length, 1);
  assert.ok(Math.abs(quad.position.x - ((target.x + target.width / 2) / XR_MENU_WIDTH - .5) * 1.04) < 1e-9, "the highlight sits on the hovered button");
  menu.setHovered([uv("preview:sku:chair")]); menu.setHovered([]); await settleXRMenu(menu);
  assert.equal(quads().length, 0); assert.equal(dom.captures(), before);
  assert.deepEqual([menu.mesh.geometry, menu.mesh.material, menu.mesh.material.map], resources);
});

test("colon-containing IDs preview a product without confirmation, then require explicit approval on any tab", async (t) => {
  const { menu, state, calls, click, setState } = await fixture(t);
  await click("preview:sku:chair"); assert.deepEqual(calls, [["preview", "sku:chair"]]);
  assert.ok(!menu.targets.some((target) => target.id === "confirm"));
  await setState({ ...state, pendingOfferId: product.id, canConfirm: true });
  assert.equal(menu.targets.find((target) => target.id === "preview:sku:chair").disabled, true);
  await click("preview:sku:chair"); assert.equal(calls.length, 1, "an active preview does not preview itself again");
  await click("tab-controls"); await click("confirm"); await click("action:cancel-preview");
  assert.deepEqual(calls, [["preview", "sku:chair"], ["confirm"], ["action", "cancel-preview"]]);
});

test("locked edits and busy shopping remain disabled while voice stop, navigation and close remain usable", async (t) => {
  const { menu, state, calls, click, setState } = await fixture(t);
  // The selected piece's toolbar (as on the website) shows rotate/put away; both stay disabled while locked.
  await setState({ ...state, selectedItemLocked: true });
  for (const id of ["action:rotate-selected", "action:store-selected"]) { assert.equal(menu.targets.find((target) => target.id === id).disabled, true); await click(id); }
  assert.deepEqual(calls, []);
  await setState({ ...state, busy: true, pendingOfferId: product.id, canConfirm: true });
  await click("confirm"); await click("tab-shop"); await click("action:search-chair");
  await click("tab-controls"); await click("locomotion"); assert.deepEqual(calls, []);
  await click("tab-agent"); await click("action:voice-toggle"); await click("action:voice-stop");
  assert.deepEqual(calls, [["action", "voice-toggle"], ["action", "voice-stop"]]);
  await click("close"); assert.deepEqual(calls.at(-1), ["close"]);
});

test("foreign pending offers, failed fit, over-budget offers and missing cancel authorization cannot activate", async (t) => {
  const { menu, state, calls, click, setState } = await fixture(t);
  await setState({ ...state, pendingOfferId: "foreign", canConfirm: true });
  assert.ok(!menu.targets.some((target) => target.id === "confirm"));
  for (const blocked of [{ fits: false }, { withinBudget: false }]) {
    await setState({ ...state, offers: [{ ...state.offers[0], ...blocked }], pendingOfferId: product.id, canConfirm: true });
    assert.equal(menu.targets.find((target) => target.id === "confirm").disabled, true); await click("confirm");
  }
  await setState({ ...state, pendingOfferId: product.id, canConfirm: true, actions: [] });
  await click("action:cancel-preview"); assert.deepEqual(calls, []);
});

test("bounded catalog keeps a later pending product pinned with unique stable IDs", async (t) => {
  const { menu, state, calls, click, setState } = await fixture(t);
  const offers = Array.from({ length: 50 }, (_, i) => ({ id: `sku:${i}`, label: `Chair ${i}`, product: { ...product, id: `sku:${i}` }, fits: true, withinBudget: true }));
  offers.splice(2, 0, { ...offers[0] });
  await setState({ ...state, offers, pendingOfferId: "sku:49", canConfirm: true });
  const previews = menu.targets.filter((target) => target.id.startsWith("preview:"));
  assert.equal(previews.length, 24); assert.equal(new Set(previews.map((target) => target.id)).size, 24);
  assert.ok(previews.some((target) => target.id === "preview:sku:49"));
  await click("confirm"); assert.deepEqual(calls, [["confirm"]]);
});

test("Agent is the default and renders supplied conversation and recommendation without manual shopping", async (t) => {
  const { dom, menu, state, click, calls, setState } = await fixture(t, { initialTab: "agent" });
  assert.equal(menu.activeTab, "agent");
  await setState({ ...state, pendingOfferId: product.id, canConfirm: true,
    agent: { available: true, connected: true, listening: true, status: "Listening", caption: "This oak chair fits your room.",
      transcript: "Find a chair under $200", activity: "Checking fit" } });
  assert.equal(menu.activeTab, "agent");
  // Like the website's voice pill: the agent's latest line floats above Talk, and the preview waits in the placement card.
  assert.match(dom.document.querySelector(".room-voice__caption").textContent, /This oak chair fits your room/);
  assert.match(dom.document.querySelector(".room-x__placement").textContent, /Oak chair/);
  await setState({ ...state, agent: { available: true, connected: true, listening: true, status: "Listening", activity: "Checking fit" }, pendingOfferId: product.id, canConfirm: true });
  assert.match(dom.document.querySelector(".room-voice__caption").textContent, /Checking fit/);
  await click("confirm"); assert.deepEqual(calls, [["confirm"]]);
  await click("tab-shop"); menu.focusAgent(); await settleXRMenu(menu); assert.equal(menu.activeTab, "agent");
});

test("invalid UVs, disabled or disconnected DOM controls and stale layouts never activate", async (t) => {
  const { dom, menu, calls, uv } = await fixture(t);
  for (const point of [new THREE.Vector2(NaN, .5), new THREE.Vector2(-1, .5), new THREE.Vector2(.5, 2), new THREE.Vector2(.999, .001)]) menu.activate(point);
  const button = dom.document.querySelector('[data-xr-id="preview:sku:chair"]'), before = uv("preview:sku:chair");
  button.disabled = true; menu.activate(before); button.disabled = false;
  const originalRect = button.getBoundingClientRect.bind(button);
  button.getBoundingClientRect = () => { const rect = originalRect(); return dom.rect(rect.x + 8, rect.y, rect.width, rect.height); };
  menu.activate(before); assert.deepEqual(calls, []); await settleXRMenu(menu);
  const latest = uv("preview:sku:chair"); button.remove(); menu.activate(latest); assert.deepEqual(calls, []);
});

test("state changes during capture discard old targets and publish only the latest DOM snapshot", async (t) => {
  const { dom, menu, state, calls, uv } = await fixture(t);
  const oldUV = uv("preview:sku:chair"), started = deferred(), finish = deferred(); let blocked = false, draws = 0;
  dom.canvasContext.drawImage = () => { draws++; };
  dom.setCaptureHook(async (_host, canvas) => { if (!blocked) { blocked = true; started.resolve(); await finish.promise; } return canvas; });
  menu.setState({ ...state, offers: [{ id: "intermediate", label: "Intermediate chair", product: { ...product, id: "intermediate" }, fits: true }] }, "walk");
  await started.promise;
  menu.setState({ ...state, offers: [{ id: "latest:chair", label: "Latest chair", product: { ...product, id: "latest:chair" }, fits: true }] }, "walk");
  menu.activate(oldUV); assert.deepEqual(calls, []);
  finish.resolve(); await settleXRMenu(menu);
  assert.equal(draws, 1, "a capture from the old state epoch never paints over the latest product state");
  assert.ok(!menu.targets.some((target) => target.id === "preview:intermediate"));
  menu.activate(uv("preview:latest:chair")); assert.deepEqual(calls, [["preview", "latest:chair"]]);
});

test("capture failures fail closed and can retry without replacing the texture", async (t) => {
  const { dom, menu, state, calls } = await fixture(t, { initialTab: "agent" });
  const texture = menu.mesh.material.map;
  dom.setCaptureHook(() => { throw new Error("rasterizer unavailable"); });
  menu.setState({ ...state, status: "New status" }, "walk"); await settleXRMenu(menu);
  assert.equal(menu.targets.length, 0); menu.activate(new THREE.Vector2(.5, .5)); assert.deepEqual(calls, []);
  dom.setCaptureHook(undefined); menu.focusAgent(); await settleXRMenu(menu);
  assert.ok(menu.targets.length > 0); assert.equal(menu.mesh.material.map, texture);
});

test("disposal releases DOM and GPU resources once and ignores an asynchronous stale capture", async (t) => {
  const { dom, menu, state, calls } = await fixture(t);
  const resources = [menu.mesh.geometry, menu.mesh.material, menu.mesh.material.map], disposed = [];
  resources.forEach((resource, index) => resource.addEventListener("dispose", () => disposed.push(index)));
  const started = deferred(), finish = deferred();
  dom.setCaptureHook(async (_host, canvas) => { started.resolve(); await finish.promise; return canvas; });
  menu.setState({ ...state, status: "Waiting on capture" }, "walk"); await started.promise;
  const texture = menu.mesh.material.map, version = texture.version;
  menu.dispose(); menu.dispose(); await menu.whenIdle();
  finish.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(texture.version, version); assert.deepEqual(disposed.sort(), [0, 1, 2]);
  assert.equal(menu.targets.length, 0); assert.equal(dom.document.querySelector("[data-tadaima-xr-host]"), null);
  menu.activate(new THREE.Vector2(.5, .5)); assert.deepEqual(calls, []);
});

test("DOM scrolling invalidates old layout until a matching capture is published", async (t) => {
  const { dom, menu, state, calls, uv } = await fixture(t);
  const scroller = dom.document.querySelector("[data-xr-scroll]");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1600 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  const oldUV = uv("preview:sku:chair");
  menu.scroll(42); assert.equal(scroller.scrollTop, 42); menu.activate(oldUV); assert.deepEqual(calls, []);
  await settleXRMenu(menu); menu.activate(uv("preview:sku:chair")); assert.deepEqual(calls, [["preview", "sku:chair"]]);
  menu.scroll(Infinity); menu.scroll(NaN); assert.equal(scroller.scrollTop, 42);
  menu.scroll(10000); assert.equal(scroller.scrollTop, 1100);
  menu.setState(state, "walk"); await settleXRMenu(menu);
});


test("font readiness recaptures the same surface and font events cannot revive a disposed panel", async (t) => {
  const ready = deferred(), fonts = new EventTarget(); fonts.ready = ready.promise;
  const { dom, menu } = await fixture(t, { fonts });
  const texture = menu.mesh.material.map, before = dom.captures();
  ready.resolve(); await new Promise((resolve) => setImmediate(resolve)); await settleXRMenu(menu);
  assert.equal(dom.captures(), before + 1); assert.equal(menu.mesh.material.map, texture);
  fonts.dispatchEvent(new Event("loadingdone")); await settleXRMenu(menu);
  assert.equal(dom.captures(), before + 2);
  menu.dispose(); fonts.dispatchEvent(new Event("loadingdone")); await settleXRMenu(menu);
  assert.equal(dom.captures(), before + 2);
});

test("Inventory, hotbar and Basket render supplied items, prices and canonical item action IDs", async (t) => {
  const { dom, menu, state, calls, click, setState } = await fixture(t);
  await setState({ ...state, selectedItemLocked: true,
    inventory: [{ id: "scan:chair", label: "Captured chair", dimensions: [.8, .9, .7], selected: true, locked: true },
      { id: "stored:lamp", label: "Saved lamp", dimensions: [.3, 1.2, .3], stored: true }],
    basket: [{ id: "new:chair", label: "New oak chair", dimensions: [.8, .9, .7], priceMinor: 12900, currency: "USD" }], basketTotal: "$129.00",
    actions: [...state.actions, ...["take-out:stored:lamp", "remove-item:new:chair"].map((id) => ({ id, label: id }))] });
  // Selection shows on the docked toolbar; stored pieces sit in the website's hotbar and Inventory drawer.
  assert.match(dom.document.querySelector(".room-x__info").textContent, /Locked/);
  assert.equal(dom.document.querySelectorAll(".room-x__hotbar [data-filled]").length, 1);
  await click("tab-room");
  assert.match(dom.document.querySelector('[aria-label="Inventory"].room-x__panel').textContent, /Saved lamp/);
  assert.doesNotMatch(dom.document.querySelector('[aria-label="Inventory"].room-x__panel').textContent, /Captured chair/);
  // The drawer's button has its own ray id (the hotbar slot for the same piece also exists) and still takes it out.
  assert.ok(menu.targets.some((target) => target.id === "drawer-take-out:stored:lamp"), "drawer Take out is a ray target");
  await click("drawer-take-out:stored:lamp");
  await click("tab-basket"); assert.match(dom.document.body.textContent, /New oak chair/);
  assert.match(dom.document.querySelector(".room-x__total").textContent, /Total\s*\$129\.00/);
  await click("action:remove-item:new:chair");
  assert.deepEqual(calls, [["action", "take-out:stored:lamp"], ["action", "remove-item:new:chair"]]);
  assert.equal(menu.activeTab, "basket");
});


test("continuous scroll paints same-state progress read-only until a fresh final capture publishes targets", async (t) => {
  const { dom, menu, calls, uv } = await fixture(t);
  const scroller = dom.document.querySelector("[data-xr-scroll]");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1600 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  const oldUV = uv("preview:sku:chair"), firstStarted = deferred(), firstFinish = deferred(), secondStarted = deferred(), secondFinish = deferred();
  let draws = 0, captures = 0, active = 0, maxActive = 0;
  dom.canvasContext.drawImage = () => { draws++; };
  dom.setCaptureHook(async (_host, canvas) => {
    const index = captures++; active++; maxActive = Math.max(maxActive, active);
    try {
      if (index === 0) { firstStarted.resolve(); await firstFinish.promise; }
      else if (index === 1) { secondStarted.resolve(); await secondFinish.promise; }
      return canvas;
    } finally { active--; }
  });
  menu.scroll(10); await firstStarted.promise;
  menu.scroll(20); menu.scroll(15);
  firstFinish.resolve(); await secondStarted.promise;
  assert.equal(draws, 1, "the completed same-state frame makes visible scroll progress even when its layout is already stale");
  assert.equal(menu.targets.length, 0, "outdated rendered layout is read-only");
  menu.activate(oldUV); assert.deepEqual(calls, []);
  menu.scroll(5); secondFinish.resolve(); await settleXRMenu(menu);
  assert.equal(draws, 3, "each stale same-state capture paints progress before a final matching capture");
  assert.equal(captures, 3); assert.equal(maxActive, 1, "rasterization never overlaps during rapid scroll updates");
  assert.ok(menu.targets.length > 0);
  menu.activate(uv("preview:sku:chair")); assert.deepEqual(calls, [["preview", "sku:chair"]]);
});

test("only painted UI owns the ray; transparent gaps between the website's cards reach the room", async (t) => {
  const { dom, menu, state, setState } = await fixture(t, { initialTab: "agent" });
  // Lay out the painted surfaces as one small card; buttons keep the fixture's grid (all left of x = 932).
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-xr-solid") && !this.hasAttribute("data-xr-id") ? dom.rect(0, 0, 300, 200) : original.call(this);
  };
  t.after(() => { dom.window.HTMLElement.prototype.getBoundingClientRect = original; });
  await setState({ ...state, status: "relayout" });
  const at = (x, y) => new THREE.Vector2(x / 960, 1 - y / (2000 / 3));
  assert.equal(menu.covers(at(150, 100)), true, "a ray on a card must not select furniture behind it");
  assert.equal(menu.covers(at(950, 650)), false, "a ray through empty space selects the room, as clicking the website's canvas does");
  assert.equal(menu.covers(new THREE.Vector2(NaN, .5)), false);
});

test("a painted button stays clickable while a newer state is still capturing", async (t) => {
  const { dom, menu, state, calls, uv } = await fixture(t);
  const target = uv("preview:sku:chair"), started = deferred(), finish = deferred();
  dom.setCaptureHook(async (_host, canvas) => { started.resolve(); await finish.promise; return canvas; });
  // A voice caption arrives; the chair card does not move.
  menu.setState({ ...state, agent: { ...state.agent, caption: "Here are chairs that fit." } }, "walk"); await started.promise;
  menu.activate(target);
  assert.deepEqual(calls, [["preview", "sku:chair"]], "voice updates must not swallow presses on unchanged buttons");
  finish.resolve(); await settleXRMenu(menu);
});

test("unrelated repaint requests during a capture do not disable clicks on the published picture", async (t) => {
  const { dom, menu, state, calls, uv } = await fixture(t);
  const started = deferred(), finish = deferred(); let first = true;
  dom.setCaptureHook(async (_host, canvas) => { if (first) { first = false; started.resolve(); await finish.promise; } return canvas; });
  menu.setState({ ...state, status: "Checking IKEA live for more" }, "walk"); await started.promise;
  dom.document.querySelector("[data-tadaima-xr-host]").dispatchEvent(new dom.window.Event("load")); // a product image finished
  finish.resolve(); await settleXRMenu(menu);
  assert.ok(menu.targets.length > 0, "the capture still matches the layout, so it is interactive");
  menu.activate(uv("preview:sku:chair")); assert.deepEqual(calls, [["preview", "sku:chair"]]);
});

test("outside an immersive session the panel never captures; entering paints the current state", async (t) => {
  const { dom, menu, state } = await fixture(t);
  menu.setActive(false); const before = dom.captures();
  menu.setState({ ...state, status: "Changed on the flat page" }, "walk"); await settleXRMenu(menu);
  assert.equal(dom.captures(), before, "no 60–120 ms capture stalls the flat page");
  menu.setActive(true); await settleXRMenu(menu);
  assert.equal(dom.captures(), before + 1);
  assert.match(dom.document.body.textContent, /Changed on the flat page/);
});

test("a capture that never finishes shows the failure panel instead of freezing the menu", async (t) => {
  const { dom, menu, state, calls } = await fixture(t);
  dom.runtime.captureTimeoutMs = 50;
  dom.setCaptureHook(() => new Promise(() => {})); // e.g. an image that never loads in the clone
  menu.setState({ ...state, status: "Stalls" }, "walk");
  await settleXRMenu(menu); // resolves only because the stalled capture timed out
  assert.equal(menu.targets.length, 0); menu.activate(new THREE.Vector2(.5, .5)); assert.deepEqual(calls, []);
  assert.equal(menu.covers(new THREE.Vector2(.5, .5)), true, "the failure panel still owns the ray");
});
