import * as THREE from "three";
import type { WorkspaceXRShopping, WorkspaceXRLocomotion } from "./workspace-xr";

export const XR_MENU_WIDTH = 1440;
export const XR_MENU_HEIGHT = 1000;
export type XRMenuTab = "shop" | "room" | "agent" | "controls";
export type XRMenuTarget = {
  id: string; x: number; y: number; width: number; height: number; disabled: boolean;
};
export type XRMenuCallbacks = {
  onPreviewOffer(id: string): void;
  onConfirmOffer(): void;
  onAction(id: string): void;
  onLocomotionToggle(): void;
  onExit(): void;
  onClose(): void;
};

type MenuState = WorkspaceXRShopping & {
  basketLabel?: string; selectedItemLocked?: boolean; busy?: boolean;
};
type Icon = "chair" | "rug" | "lamp" | "box";
// Match RoomsPage.css and RoomExperience.css, with opaque surfaces for VR contrast.
export const XR_MENU_INK = "#2b1a10";
const C = {
  paper: "#f5f2eb", ink: XR_MENU_INK, muted: "#8a6e4e", line: "rgba(43, 26, 16, 0.14)",
  white: "#fbf8f2", inkHover: "#46301f", well: "#ebe5d9",
  hover: "#e8e1d5", disabled: "#ebe5d9", disabledInk: "#927f6d", danger: "#9b3a24",
};
const FALLBACK_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const clean = (text: string | undefined, max = 240) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** One unlit draw call. All hit regions use the same pixel layout as the texture. */
export function createXRMenu(callbacks: XRMenuCallbacks) {
  const canvas = document.createElement("canvas");
  canvas.width = XR_MENU_WIDTH; canvas.height = XR_MENU_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The VR menu needs a 2D canvas context.");
  const ctx = context;
  // Canvas text cannot resolve CSS var() expressions itself. Use the same
  // Next.js font families as the site, then repaint after those faces load.
  const style = document.defaultView?.getComputedStyle(document.documentElement);
  const bodyFont = style?.getPropertyValue("--font-body").trim() || FALLBACK_FONT;
  const displayFont = style?.getPropertyValue("--font-display").trim() || bodyFont;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 1.04 * XR_MENU_HEIGHT / XR_MENU_WIDTH), material);
  mesh.name = "workspace-xr-menu";
  mesh.renderOrder = 20;
  let state: MenuState = { offers: [] };
  let locomotion: WorkspaceXRLocomotion = "walk";
  let tab: XRMenuTab = "agent";
  let targets: XRMenuTarget[] = [];
  let hovered = new Set<string>();
  let disposed = false;

  function rounded(x: number, y: number, width: number, height: number, radius = 22) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y); ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r); ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function box(x: number, y: number, width: number, height: number, fill: string, stroke?: string, radius = 22) {
    rounded(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }

  function fit(text: string, width: number) {
    if (ctx.measureText(text).width <= width) return text;
    let end = text.length;
    while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--;
    return end ? `${text.slice(0, end)}…` : "";
  }

  function text(value: string, x: number, y: number, size = 34, color = C.ink, width = 1260, weight = 400, display = false) {
    ctx.font = `${weight} ${size}px ${display ? displayFont : bodyFont}`; ctx.textBaseline = "middle";
    ctx.fillStyle = color; ctx.fillText(fit(value, width), x, y);
  }

  function paragraph(value: string, x: number, y: number, width: number, size = 30, color = C.muted, maxLines = 2) {
    ctx.font = `400 ${size}px ${bodyFont}`;
    const words = value.split(" "); let line = "", row = 0;
    for (let index = 0; index < words.length; index++) {
      const candidate = line ? `${line} ${words[index]}` : words[index];
      if (ctx.measureText(candidate).width > width && line && row < maxLines - 1) {
        text(line, x, y + row * size * 1.35, size, color, width); row++; line = words[index];
      } else line = candidate;
    }
    text(line, x, y + row * size * 1.35, size, color, width);
  }

  function target(id: string, x: number, y: number, width: number, height: number, disabled = false) {
    targets.push({ id, x, y, width, height, disabled });
    return !disabled && hovered.has(id);
  }

  function button(id: string, label: string, x: number, y: number, width: number, height: number,
    options: { disabled?: boolean; primary?: boolean; danger?: boolean; selected?: boolean } = {}) {
    const over = target(id, x, y, width, height, !!options.disabled);
    const dark = options.primary || options.selected;
    box(x, y, width, height, options.disabled ? C.disabled : dark ? over ? C.inkHover : C.ink : over ? C.hover : C.white,
      dark || options.disabled ? undefined : C.line, height / 2);
    ctx.font = `500 34px ${bodyFont}`;
    const labelWidth = Math.min(width - 42, ctx.measureText(label).width);
    text(label, x + (width - labelWidth) / 2, y + height / 2, 34,
      options.disabled ? C.disabledInk : dark ? C.white : options.danger ? C.danger : C.ink, width - 42, 500);
  }

  function icon(kind: Icon, x: number, y: number, size = 70) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size / 70, size / 70);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (kind === "chair") {
      ctx.moveTo(15, 38); ctx.lineTo(15, 12); ctx.quadraticCurveTo(35, 5, 55, 12); ctx.lineTo(55, 38);
      ctx.moveTo(10, 39); ctx.lineTo(60, 39); ctx.lineTo(60, 48); ctx.lineTo(10, 48); ctx.closePath();
      ctx.moveTo(16, 48); ctx.lineTo(13, 65); ctx.moveTo(54, 48); ctx.lineTo(57, 65);
    } else if (kind === "rug") {
      ctx.moveTo(12, 15); ctx.lineTo(58, 15); ctx.lineTo(58, 55); ctx.lineTo(12, 55); ctx.closePath();
      ctx.moveTo(22, 24); ctx.lineTo(48, 24); ctx.lineTo(48, 46); ctx.lineTo(22, 46); ctx.closePath();
      for (let i = 15; i <= 55; i += 10) { ctx.moveTo(i, 9); ctx.lineTo(i, 15); ctx.moveTo(i, 55); ctx.lineTo(i, 61); }
    } else if (kind === "lamp") {
      ctx.moveTo(23, 10); ctx.lineTo(47, 10); ctx.lineTo(59, 34); ctx.lineTo(11, 34); ctx.closePath();
      ctx.moveTo(35, 34); ctx.lineTo(35, 61); ctx.moveTo(21, 62); ctx.lineTo(49, 62);
    } else {
      ctx.moveTo(35, 8); ctx.lineTo(60, 22); ctx.lineTo(60, 50); ctx.lineTo(35, 64); ctx.lineTo(10, 50); ctx.lineTo(10, 22); ctx.closePath();
      ctx.moveTo(10, 22); ctx.lineTo(35, 36); ctx.lineTo(60, 22); ctx.moveTo(35, 36); ctx.lineTo(35, 64);
    }
    ctx.stroke(); ctx.restore();
  }

  function action(id: string) { return state.actions?.find((item) => item.id === id); }
  function actionDisabled(id: string) { const item = action(id); return !!state.busy || !item || !!item.disabled; }
  function category(label: string): Icon {
    return /chair|seat|stool|sofa/i.test(label) ? "chair" : /rug|carpet/i.test(label) ? "rug" : /lamp|light/i.test(label) ? "lamp" : "box";
  }

  function shop() {
    text("Add furniture", 64, 286, 42, C.ink, 1110, 500, true);
    const categories = [{ id: "search-chair", label: "Chairs", kind: "chair" }, { id: "search-rug", label: "Rugs", kind: "rug" }, { id: "search-lamp", label: "Lamps", kind: "lamp" }] as const;
    categories.forEach((item, index) => {
      const x = 64 + index * 444, id = `action:${item.id}`, disabled = actionDisabled(item.id);
      const over = target(id, x, 328, 424, 92, disabled);
      box(x, 328, 424, 92, disabled ? C.disabled : over ? C.hover : C.white, disabled ? undefined : C.line, 46);
      icon(item.kind, x + 24, 351, 46);
      text(item.label, x + 94, 374, 34, disabled ? C.disabledInk : C.ink, 300, 500);
    });
    if (!state.offers.length) {
      box(64, 444, 1312, 354, C.well);
      icon("chair", 674, 476, 90);
      text(state.busy ? "Finding pieces for your room…" : "Find furniture that fits", 104, 616, 38, C.ink, 1232, 500);
      paragraph(state.busy ? "You can keep looking around. Results will appear here." : "Point at a clear floor spot, then choose Chairs, Rugs or Lamps above.", 104, 676, 1210, 32);
    } else {
      state.offers.slice(0, 3).forEach((offer, index) => {
        const y = 440 + index * 124, selected = state.pendingOfferId === offer.id;
        const over = target(`preview:${offer.id}`, 64, y, 1312, 112, !!state.busy);
        box(64, y, 1312, 112, selected ? C.well : over ? C.hover : C.white, selected ? C.ink : C.line);
        box(80, y + 14, 84, 84, C.paper, undefined, 14); icon(category(offer.label), 94, y + 27, 56);
        text(offer.label, 188, y + 37, 35, state.busy ? C.disabledInk : C.ink, 884, 500);
        text(offer.detail || "View a sized preview in your room", 188, y + 80, 32, C.muted, 884);
        text(selected ? "Previewing" : "Try in room", 1100, y + 56, 32, C.ink, 248, 500);
      });
    }
  }

  function room() {
    text("Your room", 64, 286, 42, C.ink, 1240, 500, true);
    box(64, 332, 1312, 158, C.well);
    text(state.selectedItemLabel ? "SELECTED PIECE" : "YOUR ROOM", 104, 374, 25, C.muted, 1200, 500);
    text(state.selectedItemLabel || "Point at any piece to select it", 104, 431, 39, C.ink, 1200, 500);
    const locked = !!state.selectedItemLocked;
    button("action:rotate-selected", "Rotate 45°", 64, 522, 640, 112,
      { disabled: locked || actionDisabled("rotate-selected") });
    button("action:store-selected", "Put in storage", 736, 522, 640, 112,
      { disabled: locked || actionDisabled("store-selected") });
    box(64, 670, 1312, 128, C.white, C.line);
    paragraph(locked ? "This piece is locked. Unlock it on the room’s website before changing its placement." :
      state.selectedItemLabel ? "Rotate or store the selected piece. Your scanned room and shopping basket stay in sync." :
      "Aim your controller at furniture and pull the trigger. Your selection appears here.", 104, 714, 1224, 32);
  }

  function agent() {
    const voice = state.agent, recommendation = state.offers.find((offer) => offer.id === state.pendingOfferId);
    text(recommendation ? "Tadaima recommends" : "Tell Tadaima what you need", 64, 286, 42, C.ink, 1240, 500, true);
    box(64, 332, 1312, 138, C.well);
    text(recommendation?.label || (voice?.available ? voice.activity || voice.status || "Ready to talk" : "Your room agent isn’t connected yet"), 104, 378, 38, C.ink, 1210, 500);
    text(recommendation?.detail || (voice?.listening ? "Microphone on · tap Finish speaking when you’re done" :
      voice?.available ? "Describe what you want. Tadaima handles the search and fit." : "Agent setup is needed. You can still browse in Shop."), 104, 434, 30, C.muted, 1210);
    const toggle = action("voice-toggle"), stop = action("voice-stop");
    button("action:voice-toggle", voice?.listening ? "Finish speaking" : "Talk to Tadaima", 64, 502, 640, 100,
      { primary: !recommendation, disabled: !voice?.available || !toggle || !!toggle.disabled });
    button("action:voice-stop", "End conversation", 736, 502, 640, 100,
      { disabled: !stop || !!stop.disabled });
    box(64, 636, 1312, 162, C.white, C.line);
    const explanation = voice?.error || (voice?.activity ? `${voice.activity}…` : voice?.caption) ||
      (recommendation ? "This piece is previewed in your room. Say ‘place it’ to add it, or ask Tadaima for another option." : voice?.transcript ? `You asked: ${voice.transcript}` : voice?.available ? "Try: ‘Find me a comfortable chair under $200.’ Tadaima searches, checks fit and shows you a recommendation before adding anything." :
      "Voice is unavailable on this server. Once connected, the agent can search, preview and rearrange this room with your approval.");
    paragraph(explanation, 104, 676, 1224, 30, voice?.error ? C.danger : C.muted, 3);
  }

  function controls() {
    text("Your controls", 64, 286, 42, C.ink, 1240, 500, true);
    box(64, 332, 1312, 148, C.well);
    text(locomotion === "walk" ? "Walking is on" : "Teleport is on", 104, 378, 38, C.ink, 690, 500);
    text(locomotion === "walk" ? "Left stick walks and strafes" : "Aim at floor, release left stick", 104, 434, 30, C.muted, 700);
    button("locomotion", locomotion === "walk" ? "Use teleport" : "Use walking", 928, 360, 416, 92, { disabled: !!state.busy });
    box(64, 514, 1312, 178, C.white, C.line);
    text("RIGHT STICK", 104, 554, 25, C.muted, 500, 500); text("Snap-turn your view", 104, 610, 34, C.ink, 580, 500);
    text("LEFT GRIP", 770, 554, 25, C.muted, 500, 500); text("Bring this menu to you", 770, 610, 34, C.ink, 560, 500);
    button("exit", "Exit VR", 64, 714, 1312, 90, { danger: true });
  }

  function footer() {
    ctx.fillStyle = C.line; ctx.fillRect(64, 828, 1312, 2);
    if (state.pendingOfferId) {
      const pending = state.offers.find((offer) => offer.id === state.pendingOfferId);
      text(state.canConfirm && !state.busy ? "Ready to place" : state.busy ? "Updating your room…" : "Placement needs attention", 64, 868, 32, C.ink, 438, 500);
      text(!state.canConfirm && state.status ? state.status : pending?.label || "Furniture preview", 64, 913, 28, C.muted, 438);
      button("action:cancel-preview", "Cancel preview", 526, 856, 358, 92,
        { disabled: actionDisabled("cancel-preview") });
      button("confirm", "Confirm placement", 908, 856, 468, 92,
        { primary: true, disabled: !state.canConfirm || !!state.busy });
    } else {
      paragraph(state.status || (state.busy ? "Updating your room…" : "Your room, your pace. Choose a piece to get started."), 64, 875, 1280, 30, C.muted, 2);
      text("Preview and placement only · checkout stays on the website", 64, 953, 25, C.muted, 1280);
    }
  }

  function draw() {
    if (disposed) return;
    targets = [];
    ctx.clearRect(0, 0, XR_MENU_WIDTH, XR_MENU_HEIGHT);
    box(4, 4, XR_MENU_WIDTH - 8, XR_MENU_HEIGHT - 8, C.paper, C.line, 44);
    text("tadaima", 64, 84, 54, C.ink, 380, 500, true);
    if (state.basketLabel) {
      box(838, 48, 390, 72, C.well, undefined, 36);
      text(state.basketLabel, 866, 84, 32, C.ink, 336, 500);
    }
    button("close", "×", 1284, 40, 92, 92);
    (["shop", "room", "agent", "controls"] as const).forEach((item, index) => {
      button(`tab-${item}`, item[0].toUpperCase() + item.slice(1), 64 + index * 332, 154, 316, 92, { selected: tab === item });
    });
    if (tab === "shop") shop(); else if (tab === "room") room(); else if (tab === "agent") agent(); else controls();
    footer();
    texture.needsUpdate = true;
  }

  function hit(uv: THREE.Vector2) {
    if (![uv.x, uv.y].every(Number.isFinite) || uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return;
    const x = uv.x * XR_MENU_WIDTH, y = (1 - uv.y) * XR_MENU_HEIGHT;
    return targets.find((item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
  }

  function visibleKey() {
    const footerState = state.pendingOfferId ? [state.pendingOfferId, state.canConfirm, state.busy,
      !state.canConfirm ? state.status : state.offers.find((offer) => offer.id === state.pendingOfferId)?.label,
      action("cancel-preview")?.disabled] : [state.status, state.busy];
    const body = tab === "shop" ? [state.offers, state.pendingOfferId, state.busy,
      ["search-chair", "search-rug", "search-lamp"].map(actionDisabled)] : tab === "room" ?
      [state.selectedItemLabel, state.selectedItemLocked, actionDisabled("rotate-selected"), actionDisabled("store-selected")] : tab === "agent" ?
      [state.agent, state.pendingOfferId, state.offers.find((offer) => offer.id === state.pendingOfferId), action("voice-toggle")?.disabled, action("voice-stop")?.disabled] : [locomotion, state.busy];
    return JSON.stringify([tab, state.basketLabel, body, footerState]);
  }

  draw();
  if (document.fonts?.load) {
    void Promise.allSettled([
      document.fonts.load(`400 34px ${bodyFont}`),
      document.fonts.load(`500 34px ${bodyFont}`),
      document.fonts.load(`500 54px ${displayFont}`),
    ]).then(() => draw()); // draw() ignores completion after disposal.
  }
  return {
    mesh,
    get targets(): readonly XRMenuTarget[] { return targets; },
    get activeTab(): XRMenuTab { return tab; },
    focusAgent() { if (!disposed && tab !== "agent") { tab = "agent"; hovered.clear(); draw(); } },
    setState(next: WorkspaceXRShopping, nextLocomotion: WorkspaceXRLocomotion) {
      if (disposed) return;
      const input = next as MenuState;
      const offers = input.offers.slice(0, 3).map((offer) => ({ id: offer.id, label: clean(offer.label, 160), detail: clean(offer.detail) }));
      const pendingOfferId = offers.some((offer) => offer.id === input.pendingOfferId) ? input.pendingOfferId : null;
      const projected: MenuState = {
        offers,
        actions: (input.actions ?? []).filter((item) => ["search-chair", "search-rug", "search-lamp", "rotate-selected", "store-selected", "cancel-preview", "voice-toggle", "voice-stop"].includes(item.id))
          .map((item) => ({ id: item.id, label: "", disabled: !!item.disabled })),
        selectedItemLabel: clean(input.selectedItemLabel, 160), status: clean(input.status),
        pendingOfferId, canConfirm: !!pendingOfferId && !!input.canConfirm,
        agent: input.agent ? { available: !!input.agent.available, status: clean(input.agent.status, 120), caption: clean(input.agent.caption, 600), listening: !!input.agent.listening, connected: !!input.agent.connected, error: clean(input.agent.error, 300), activity: clean(input.agent.activity, 160), transcript: clean(input.agent.transcript, 300) } : undefined,
        basketLabel: clean(input.basketLabel, 80), selectedItemLocked: !!input.selectedItemLocked, busy: !!input.busy,
      };
      const before = visibleKey();
      state = projected; locomotion = nextLocomotion;
      if (visibleKey() !== before) { hovered.clear(); draw(); }
    },
    setHovered(uvs: readonly THREE.Vector2[]) {
      if (disposed) return;
      const next = new Set(uvs.map(hit).filter((item): item is XRMenuTarget => !!item && !item.disabled).map((item) => item.id));
      if (next.size === hovered.size && [...next].every((id) => hovered.has(id))) return;
      hovered = next; draw();
    },
    activate(uv: THREE.Vector2) {
      if (disposed) return;
      const item = hit(uv);
      if (!item || item.disabled) return;
      if (item.id.startsWith("tab-")) { tab = item.id.slice(4) as XRMenuTab; hovered.clear(); draw(); }
      else if (item.id.startsWith("preview:")) callbacks.onPreviewOffer(item.id.slice(8));
      else if (item.id.startsWith("action:")) callbacks.onAction(item.id.slice(7));
      else if (item.id === "confirm") callbacks.onConfirmOffer();
      else if (item.id === "locomotion") callbacks.onLocomotionToggle();
      else if (item.id === "exit") callbacks.onExit();
      else if (item.id === "close") callbacks.onClose();
    },
    dispose() {
      if (disposed) return;
      disposed = true; mesh.removeFromParent(); mesh.geometry.dispose(); material.dispose(); texture.dispose();
      targets = []; hovered.clear();
    },
  };
}
