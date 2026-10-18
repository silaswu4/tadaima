import { Window } from "happy-dom";
import { registerHooks } from "node:module";

// Browser styles are verified by visual QA; this DOM fixture has no CSS layout engine.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  // Next resolves static images to { src, width, height }; the panel only reads src.
  if (url.endsWith(".png")) return { format: "module", source: `export default { src: ${JSON.stringify(new URL(url).pathname)}, width: 1, height: 1 };`, shortCircuit: true };
  return nextLoad(url, context);
} });

/** Actual React DOM/event behavior; only browser layout and rasterization are mocked. */
export function createXRDOMFixture() {
  const window = new Window({ url: "http://127.0.0.1:3017" });
  const { document } = window;
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "Element", "Node", "MutationObserver", "ResizeObserver", "MouseEvent"]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : window[key] });
  }
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  Object.defineProperty(window, "isSecureContext", { configurable: true, writable: true, value: true });
  const canvasContext = new Proxy({ clearRect() {}, drawImage() {}, measureText(text) { return { width: String(text).length * 8 }; } },
    { get: (target, key) => key in target ? target[key] : () => {} });
  window.HTMLCanvasElement.prototype.getContext = function () { return canvasContext; };
  function rect(x = 0, y = 0, width = 960, height = 2000 / 3) {
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() { return this; } };
  }
  // Happy DOM has no layout engine. Fixed, nonoverlapping rectangles let the
  // adapter measure real mounted elements without duplicating UI/action logic.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-xr-id")) {
      const ancestors = [this];
      while (ancestors.at(-1).parentElement && ancestors.at(-1).parentElement !== document.body) ancestors.push(ancestors.at(-1).parentElement);
      const host = ancestors.at(-1);
      const index = [...host.querySelectorAll("[data-xr-id]")].indexOf(this);
      return rect(20 + index % 7 * 132, 20 + Math.floor(index / 7) * 102 - (this.closest("[data-xr-scroll]")?.scrollTop ?? 0), 120, 80);
    }
    return rect();
  };
  let captures = 0, captureHook;
  const makeCanvas = () => { const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 2000 / 3; return canvas; };
  const runtime = { document, minCaptureIntervalMs: 0, capture: async (host) => {
    captures++;
    const canvas = makeCanvas();
    return captureHook ? captureHook(host, canvas) : canvas;
  } };
  return { window, document, runtime, captures: () => captures, canvasContext, rect, makeCanvas,
    setCaptureHook(callback) { captureHook = callback; },
    async close() { await window.happyDOM.close(); } };
}

export async function settleXRMenu(menu) {
  await menu.whenIdle();
  // React effects can schedule one layout pass after its first capture.
  await new Promise((resolve) => setImmediate(resolve));
  await menu.whenIdle();
}
