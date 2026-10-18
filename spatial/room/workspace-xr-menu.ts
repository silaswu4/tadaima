import * as THREE from "three";
import { mountXRPanel } from "../components/RoomXRPanel";
import type { XRPanelProps, XRPanelTab } from "../components/RoomXRPanel";
import type { WorkspaceXRShopping, WorkspaceXRLocomotion } from "./workspace-xr";

export const XR_MENU_WIDTH = 1440;
export const XR_MENU_HEIGHT = 1000;
export const XR_MENU_INK = "#2b1a10";
export type XRMenuTab = XRPanelTab;
export type XRMenuTarget = { id: string; x: number; y: number; width: number; height: number; disabled: boolean };
export type XRMenuCallbacks = {
  onPreviewOffer(id: string): void; onConfirmOffer(): void; onAction(id: string): void;
  onLocomotionToggle(): void; onExit(): void; onClose(): void;
};
/** Injectable DOM/capture boundary; production mounts and captures the real React UI. */
export type XRMenuRuntime = {
  document?: Document; mountPanel?: typeof mountXRPanel;
  capture?: (host: HTMLElement) => Promise<HTMLCanvasElement>;
  minCaptureIntervalMs?: number;
};
type TargetRecord = { target: XRMenuTarget; button: HTMLElement; radius: number };
type Rect = { x: number; y: number; width: number; height: number };
// The website's room overlay at its own CSS sizes, upscaled 2.25x so 11–13px text stays legible in the headset.
const HOST_SCALE = XR_MENU_WIDTH / 640, HOST_WIDTH = 640, HOST_HEIGHT = Math.round(XR_MENU_HEIGHT / HOST_SCALE);
const TABS: readonly XRMenuTab[] = ["agent", "shop", "room", "basket", "controls"];
let nextHostId = 0;

async function captureDOM(host: HTMLElement) {
  const { default: html2canvas } = await import("html2canvas");
  const identity = host.getAttribute("data-tadaima-xr-host");
  return html2canvas(host, {
    width: HOST_WIDTH, height: HOST_HEIGHT, scale: HOST_SCALE,
    useCORS: true, allowTaint: false, backgroundColor: null, logging: false,
    // Match the live viewport so media queries lay the clone out like the measured buttons.
    imageTimeout: 1500, scrollX: 0, scrollY: 0, windowWidth: host.ownerDocument.defaultView?.innerWidth ?? 1440,
    windowHeight: host.ownerDocument.defaultView?.innerHeight ?? 900,
    ignoreElements: (element) => element.tagName === "CANVAS" && !host.contains(element),
    onclone(document) {
      const clone = document.querySelector<HTMLElement>(`[data-tadaima-xr-host="${identity}"]`);
      if (clone) { clone.style.left = "0"; clone.style.top = "0"; clone.style.transform = "none"; }
      document.documentElement.style.color = XR_MENU_INK; document.body.style.color = XR_MENU_INK;
      const style = document.createElement("style");
      style.textContent = "[data-tadaima-xr-host], [data-tadaima-xr-host] * { animation: none !important; transition: none !important; caret-color: transparent !important; }";
      document.head.appendChild(style);
    },
  });
}

/** One stable plane and texture, with ray targets measured from actual DOM buttons. */
export function createXRMenu(callbacks: XRMenuCallbacks, runtime: XRMenuRuntime = {}) {
  const doc = runtime.document ?? document;
  const host = doc.createElement("div");
  host.setAttribute("data-tadaima-xr-host", String(++nextHostId)); host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed", left: "-12000px", top: "0", width: `${HOST_WIDTH}px`, height: `${HOST_HEIGHT}px`,
    overflow: "hidden", pointerEvents: "none", zIndex: "-1", isolation: "isolate", color: XR_MENU_INK, background: "transparent",
  });
  doc.body.appendChild(host);
  const canvas = doc.createElement("canvas"); canvas.width = XR_MENU_WIDTH; canvas.height = XR_MENU_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) { host.remove(); throw new Error("The VR menu needs a 2D canvas context."); }
  // html2canvas measures font baselines in its own hidden body child using a
  // 1px inline image. Tailwind's image reset makes that probe a block, moving
  // every captured text baseline. Target only that measurement shape, in the
  // original document where CanvasRenderer creates it, never product images.
  const metricsStyle = doc.createElement("style");
  metricsStyle.setAttribute("data-tadaima-xr-font-metrics", "");
  metricsStyle.textContent = 'body > div[style*="visibility: hidden"][style*="white-space: nowrap"] > img[width="1"][height="1"] { display: inline-block !important; max-width: none !important; }';
  doc.head.appendChild(metricsStyle);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 1.04 * XR_MENU_HEIGHT / XR_MENU_WIDTH), material);
  mesh.name = "workspace-xr-menu"; mesh.renderOrder = 20;

  let state: WorkspaceXRShopping = { offers: [] };
  let locomotion: WorkspaceXRLocomotion = "walk", tab: XRMenuTab = "agent";
  let hoveredIds: string[] = [], stateKey = "";
  let stateEpoch = 0, committedEpoch = -1, paintedState = -1;
  let layoutEpoch = 0, paintedLayout = -1, layoutKey = "";
  let paintRequest = 0, lastStarted = -Infinity;
  let disposed = false, capturing = false, dirty = false, failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let records: TargetRecord[] = [], solids: Rect[] = [], panel: ReturnType<typeof mountXRPanel> | undefined;
  const waiters = new Set<() => void>();
  // One html2canvas pass blocks the Quest's main thread for ~60–120 ms (5–9 frames at 72 Hz), so content
  // changes are coalesced to at most one capture per 400 ms and hover never captures at all.
  const interval = Math.max(0, runtime.minCaptureIntervalMs ?? 400), capture = runtime.capture ?? captureDOM;

  // Hover is a small rounded tint over the measured button, one per controller ray: no React render,
  // no rasterization and only a few-kilobyte texture upload, so sweeping the ray costs nothing.
  const MENU_W = 1.04, MENU_H = 1.04 * XR_MENU_HEIGHT / XR_MENU_WIDTH;
  const highlights = [0, 1].map(() => {
    const surface = doc.createElement("canvas"); surface.width = surface.height = 8;
    const map = new THREE.CanvasTexture(surface); map.colorSpace = THREE.SRGBColorSpace;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    quad.name = "workspace-xr-menu-hover"; quad.renderOrder = 21; quad.visible = false; quad.raycast = () => {};
    mesh.add(quad);
    return { quad, surface, map, key: "" };
  });
  function placeHighlights() {
    const active = hoveredIds.map((id) => records.find((record) => record.target.id === id)).filter((record): record is TargetRecord => !!record && !record.target.disabled);
    highlights.forEach((highlight, index) => {
      const record = active[index];
      highlight.quad.visible = !!record;
      if (!record) return;
      const { x, y, width, height } = record.target;
      highlight.quad.scale.set(width / XR_MENU_WIDTH * MENU_W, height / XR_MENU_HEIGHT * MENU_H, 1);
      highlight.quad.position.set(((x + width / 2) / XR_MENU_WIDTH - .5) * MENU_W, (.5 - (y + height / 2) / XR_MENU_HEIGHT) * MENU_H, .002);
      const key = `${Math.round(width)}x${Math.round(height)}r${Math.round(record.radius)}`;
      if (key === highlight.key) return;
      highlight.key = key;
      const surface = highlight.surface, w = Math.max(8, Math.round(width / 2)), h = Math.max(8, Math.round(height / 2));
      surface.width = w; surface.height = h;
      const ctx = surface.getContext("2d");
      if (!ctx) return;
      const r = Math.min(record.radius / 2, w / 2, h / 2);
      ctx.clearRect(0, 0, w, h); ctx.beginPath(); ctx.roundRect?.(1.5, 1.5, w - 3, h - 3, Math.max(0, r - 1.5));
      ctx.fillStyle = "rgba(43, 26, 16, 0.12)"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(43, 26, 16, 0.34)"; ctx.stroke();
      highlight.map.dispose(); highlight.map.needsUpdate = true;
    });
  }

  function buttonDisabled(button: HTMLElement) {
    return (button as HTMLButtonElement).disabled === true || button.getAttribute("aria-disabled") === "true";
  }

  function measure(): TargetRecord[] {
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    const seen = new Set<string>();
    return [...host.querySelectorAll<HTMLElement>("[data-xr-id]")].flatMap((button) => {
      const id = button.getAttribute("data-xr-id"), style = doc.defaultView?.getComputedStyle(button);
      if (!id || seen.has(id) || !button.isConnected || style?.display === "none" || style?.visibility === "hidden") return [];
      const rect = button.getBoundingClientRect(), scroll = button.closest<HTMLElement>("[data-xr-scroll]")?.getBoundingClientRect();
      const left = Math.max(bounds.left, rect.left, scroll?.left ?? -Infinity), top = Math.max(bounds.top, rect.top, scroll?.top ?? -Infinity);
      const right = Math.min(bounds.right, rect.right, scroll?.right ?? Infinity), bottom = Math.min(bounds.bottom, rect.bottom, scroll?.bottom ?? Infinity);
      if (right <= left || bottom <= top) return [];
      seen.add(id);
      const radius = Math.min(parseFloat(style?.borderTopLeftRadius ?? "0") || 0, rect.height / 2) / bounds.width * XR_MENU_WIDTH;
      return [{ button, radius, target: { id, x: (left - bounds.left) / bounds.width * XR_MENU_WIDTH,
        y: (top - bounds.top) / bounds.height * XR_MENU_HEIGHT, width: (right - left) / bounds.width * XR_MENU_WIDTH,
        height: (bottom - top) / bounds.height * XR_MENU_HEIGHT, disabled: buttonDisabled(button) } }];
    });
  }
  function measurementKey(items: TargetRecord[]) {
    return JSON.stringify(items.map(({ target }) => [target.id, target.x, target.y, target.width, target.height, target.disabled]));
  }
  /** Painted UI surfaces. The texture is transparent elsewhere, so rays pass through to the room. */
  function measureSolids(): Rect[] {
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return [];
    return [...host.querySelectorAll<HTMLElement>("[data-xr-solid], [data-xr-id]")].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ x: (rect.left - bounds.left) / bounds.width * XR_MENU_WIDTH, y: (rect.top - bounds.top) / bounds.height * XR_MENU_HEIGHT,
        width: rect.width / bounds.width * XR_MENU_WIDTH, height: rect.height / bounds.height * XR_MENU_HEIGHT }];
    });
  }
  function refreshLayout() {
    solids = measureSolids();
    const items = measure(), key = measurementKey(items);
    if (key !== layoutKey) { layoutKey = key; layoutEpoch++; }
    return items;
  }
  function settle() {
    if (!disposed && (capturing || timer || dirty || committedEpoch !== stateEpoch)) return;
    for (const resolve of waiters) resolve(); waiters.clear();
  }
  function requestPaint() {
    if (disposed) return;
    dirty = true; paintRequest++;
    if (capturing || timer || committedEpoch !== stateEpoch) return;
    timer = setTimeout(() => { timer = undefined; void paint(); }, Math.max(0, interval - (Date.now() - lastStarted)));
  }
  function drawFailure() {
    records = []; paintedState = paintedLayout = -1;
    context!.clearRect(0, 0, XR_MENU_WIDTH, XR_MENU_HEIGHT);
    context!.fillStyle = "#f5f2eb"; context!.fillRect(0, 0, XR_MENU_WIDTH, XR_MENU_HEIGHT);
    context!.fillStyle = XR_MENU_INK; context!.font = "500 42px system-ui, sans-serif";
    context!.fillText("The room menu could not render.", 80, 430); context!.font = "32px system-ui, sans-serif";
    context!.fillText("Exit and enter VR to try again.", 80, 490); texture.needsUpdate = true;
  }
  async function paint() {
    if (disposed || capturing || !dirty || committedEpoch !== stateEpoch) { settle(); return; }
    dirty = false; capturing = true; lastStarted = Date.now();
    const items = refreshLayout(), request = paintRequest, expectedState = stateEpoch, expectedLayout = layoutEpoch;
    try {
      const result = await capture(host);
      if (disposed) return;
      refreshLayout();
      if (expectedState !== stateEpoch) { dirty = true; return; }
      // A held scroll stick changes layout every XR frame. Showing completed
      // frames keeps scrolling visible; only matching layout snapshots may be
      // interactive. New tabs, products, prices or other state never reuse an
      // older capture, even when the visible button IDs happen to match.
      context!.clearRect(0, 0, XR_MENU_WIDTH, XR_MENU_HEIGHT); context!.drawImage(result, 0, 0, XR_MENU_WIDTH, XR_MENU_HEIGHT);
      texture.needsUpdate = true; failed = false;
      if (request === paintRequest && expectedLayout === layoutEpoch) {
        records = items; paintedState = expectedState; paintedLayout = expectedLayout; placeHighlights();
      } else {
        records = []; paintedState = paintedLayout = -1; dirty = true; placeHighlights();
      }
    } catch {
      if (!disposed && request === paintRequest && expectedState === stateEpoch) { failed = true; drawFailure(); }
    } finally {
      capturing = false; if (dirty && !disposed) requestPaint(); settle();
    }
  }
  function navigate(next: XRMenuTab) {
    if (disposed || !TABS.includes(next)) return;
    if (tab === next) { if (failed) requestPaint(); return; }
    tab = next; hoveredIds = []; placeHighlights(); stateEpoch++; render();
  }
  function props(): XRPanelProps {
    const epoch = stateEpoch;
    return {
      state, locomotion, tab, onNavigate: navigate,
      onAction(id) {
        const action = state.actions?.find((item) => item.id === id);
        if (!disposed && action && !action.disabled && (!state.busy || id.startsWith("voice-"))) callbacks.onAction(id);
      },
      onPreviewOffer(id) { if (!disposed && !state.busy && state.offers.some((offer) => offer.id === id)) callbacks.onPreviewOffer(id); },
      onConfirmOffer() { if (!disposed && !state.busy && state.canConfirm && state.pendingOfferId && state.offers.some((offer) => offer.id === state.pendingOfferId)) callbacks.onConfirmOffer(); },
      onLocomotionToggle() { if (!disposed && !state.busy) callbacks.onLocomotionToggle(); },
      onExit() { if (!disposed) callbacks.onExit(); }, onClose() { if (!disposed) callbacks.onClose(); },
      onLayout() { if (disposed || epoch !== stateEpoch) return; committedEpoch = epoch; refreshLayout(); requestPaint(); },
    };
  }
  function render() { if (!disposed) panel?.update(props()); }
  function layoutChanged() { if (!disposed && committedEpoch === stateEpoch) { refreshLayout(); requestPaint(); } }
  host.addEventListener("load", layoutChanged, true); host.addEventListener("error", layoutChanged, true); host.addEventListener("scroll", layoutChanged, true);
  const ResizeObserverClass = doc.defaultView?.ResizeObserver;
  const observer = ResizeObserverClass ? new ResizeObserverClass(layoutChanged) : undefined;
  observer?.observe(host);
  try { panel = (runtime.mountPanel ?? mountXRPanel)(host, props()); }
  catch (error) {
    disposed = true; if (timer) clearTimeout(timer); observer?.disconnect();
    host.removeEventListener("load", layoutChanged, true); host.removeEventListener("error", layoutChanged, true); host.removeEventListener("scroll", layoutChanged, true);
    host.remove(); metricsStyle.remove(); mesh.geometry.dispose(); material.dispose(); texture.dispose(); throw error;
  }
  doc.fonts?.addEventListener("loadingdone", layoutChanged);
  if (doc.fonts?.ready) void doc.fonts.ready.then(layoutChanged, () => {});

  function covers(uv: THREE.Vector2) {
    if (disposed || failed) return !disposed;
    if (![uv.x, uv.y].every(Number.isFinite) || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return false;
    const x = uv.x * XR_MENU_WIDTH, y = (1 - uv.y) * XR_MENU_HEIGHT;
    return solids.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
  }
  function hit(uv: THREE.Vector2) {
    if (disposed || ![uv.x, uv.y].every(Number.isFinite) || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return;
    const x = uv.x * XR_MENU_WIDTH, y = (1 - uv.y) * XR_MENU_HEIGHT;
    return records.find(({ target }) => x >= target.x && x <= target.x + target.width && y >= target.y && y <= target.y + target.height);
  }
  return {
    mesh,
    get targets(): readonly XRMenuTarget[] { return records.map(({ target }) => target); },
    get activeTab(): XRMenuTab { return tab; }, focusAgent() { navigate("agent"); },
    /** Whether a ray at this UV lands on painted UI (and so must not reach the room behind). */
    covers,
    setState(next: WorkspaceXRShopping, nextLocomotion: WorkspaceXRLocomotion) {
      if (disposed) return;
      const offers = next.offers.filter((offer, index, all) => !!offer.id && all.findIndex((other) => other.id === offer.id) === index).slice(0, 24);
      const pending = next.offers.find((offer) => offer.id === next.pendingOfferId);
      if (pending && !offers.some((offer) => offer.id === pending.id)) { if (offers.length === 24) offers.pop(); offers.push(pending); }
      const pendingOfferId = offers.some((offer) => offer.id === next.pendingOfferId) ? next.pendingOfferId : null;
      const projected = { ...next, offers, pendingOfferId, canConfirm: !!pendingOfferId && next.canConfirm === true };
      const key = JSON.stringify([projected, nextLocomotion]);
      if (key === stateKey) return;
      stateKey = key; state = projected; locomotion = nextLocomotion; stateEpoch++; render();
    },
    setHovered(uvs: readonly THREE.Vector2[]) {
      if (disposed || paintedState !== stateEpoch || paintedLayout !== layoutEpoch) return;
      const ids = [...new Set(uvs.map(hit).filter((item): item is TargetRecord => !!item && !item.target.disabled).map(({ target }) => target.id))].sort();
      if (JSON.stringify(ids) === JSON.stringify(hoveredIds)) return;
      hoveredIds = ids; placeHighlights();
    },
    activate(uv: THREE.Vector2) {
      if (disposed || paintedState !== stateEpoch || paintedLayout !== layoutEpoch) return;
      const item = hit(uv);
      if (!item || item.target.disabled || buttonDisabled(item.button) || !item.button.isConnected || !host.contains(item.button)) return;
      const current = measure().find(({ target, button }) => button === item.button && target.id === item.target.id);
      if (!current || measurementKey([current]) !== measurementKey([item])) { refreshLayout(); requestPaint(); return; }
      item.button.click();
    },
    scroll(delta: number) {
      if (disposed || !Number.isFinite(delta) || !delta) return;
      const scroller = host.querySelector<HTMLElement>("[data-xr-scroll]");
      if (!scroller) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + delta));
      if (scroller.scrollTop !== before) layoutChanged();
    },
    whenIdle(): Promise<void> {
      if (disposed || (!capturing && !timer && !dirty && committedEpoch === stateEpoch)) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
    dispose() {
      if (disposed) return;
      disposed = true; if (timer) clearTimeout(timer); timer = undefined;
      observer?.disconnect();
      doc.fonts?.removeEventListener("loadingdone", layoutChanged);
      host.removeEventListener("load", layoutChanged, true); host.removeEventListener("error", layoutChanged, true); host.removeEventListener("scroll", layoutChanged, true);
      panel?.dispose(); panel = undefined; host.remove(); metricsStyle.remove(); records = []; solids = [];
      highlights.forEach(({ quad, map }) => { quad.geometry.dispose(); quad.material.dispose(); map.dispose(); });
      mesh.removeFromParent(); mesh.geometry.dispose(); material.dispose(); texture.dispose(); settle();
    },
  };
}
