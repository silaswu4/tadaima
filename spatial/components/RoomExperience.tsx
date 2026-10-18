"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FloorSpot, FurnitureCategory, Job, ProductCandidate, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult, Vector3Meters } from "../../backend/contracts";
import dynamic from "next/dynamic";
import { placeAt } from "../../backend/shopping/placement";
import { evaluate } from "../../backend/shopping/spot";
import { useRoomShopping } from "../rooms/use-room-shopping";
import { useRoomFetch } from "../rooms/use-room-fetch";
import { roomXRActions, roomXRProducts, roomXRSearch } from "../rooms/xr-actions";
import type { WalkCallbacks, WalkCarryStatus, WalkEnvironment, WalkItem, WalkMode, WalkOptions, WalkScene } from "../room/walk-api";
import mark from "../assets/tadaima-mark.png";
import { WipeLink, useWipeHold } from "./PageWipe";
import "./RoomExperience.css";

export type ExperienceRoom = { id: string; label: string; plan: RoomPlan; environment?: WalkEnvironment; reconstruction?: WalkOptions["reconstruction"]; sourceDescription?: string };
type Props = { room: ExperienceRoom; backHref?: string; onPlanChange?: (plan: RoomPlan) => Promise<void> };
type Panel = "catalog" | "basket" | "inventory" | "assistant" | null;
type Anchor = { x: number; y: number } | null;

const RoomCheckout = dynamic(() => import("./RoomCheckout").then((module) => module.RoomCheckout), { loading: () => <p role="status">Loading checkout…</p> });
const RoomAssistant = dynamic(() => import("./RoomAssistant").then((module) => module.RoomAssistant), { loading: () => <p className="room-x__toast" data-show role="status">Opening assistant…</p> });
const RoomVoice = dynamic(() => import("./RoomVoice").then((module) => module.RoomVoice), { ssr: false });

const CATEGORY_LABEL: Record<FurnitureCategory, string> = {
  sofa: "Sofas",
  chair: "Chairs",
  table: "Tables",
  desk: "Desks",
  storage: "Storage",
  bed: "Beds",
  rug: "Rugs",
  lamp: "Lamps",
  decor: "Decor",
  other: "Other",
};

const LOADING_STEPS = ["Laying the floor", "Raising the walls", "Placing your furniture", "Letting the light in"];

/** Keys the engine listens for; held back while a panel is open so they do not act on the room. */
const HOTBAR_SLOTS = 9;
/** Bump to give every browser a fresh server room (v2: demo rooms start with an empty basket and nothing locked). */
const ROOM_SESSION_VERSION = 2;

/** A small line drawing per kind of piece, for inventory slots. */
function CategoryGlyph({ category }: { category: FurnitureCategory }) {
  const paths: Record<string, string> = {
    sofa: "M3 13v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3M2 13h20v4H2zM4 17v2M20 17v2M6 8V6h12v2",
    chair: "M7 4h10v8H7zM5 12h14v3H5zM6 15v5M18 15v5",
    table: "M3 9h18M5 9v10M19 9v10M3 7h18v2H3z",
    desk: "M3 8h18v2H3zM5 10v9M19 10v9M14 10h5v5h-5z",
    storage: "M5 3h14v18H5zM5 9h14M5 15h14",
    bed: "M3 18V8M3 13h18v5M21 18v-5M6 13v-2a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2",
    rug: "M4 6h16v12H4zM7 9h10v6H7z",
    lamp: "M9 3h6l2 6H7zM12 9v10M8 21h8",
    decor: "M9 4h6v3a5 5 0 1 1-6 0z",
    other: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  };
  return (
    <svg viewBox="0 0 24 24" className="room-x__slot-glyph" aria-hidden="true">
      <path d={paths[category] ?? paths.other} />
    </svg>
  );
}

const ENGINE_KEYS = new Set(["g", "r", "q", "e", "w", "a", "s", "d", "delete", "backspace", "z", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
const HINT_KEY = "tadaima.walkHintSeen";
const ROTATE_STEP = Math.PI / 4;

/* ---------- formatting ---------- */

const cm = (m: number) => Math.max(1, Math.round(m * 100));
const inches = (m: number) => String(Math.round((m / 0.0254) * 10) / 10);

/** Width x depth x height, from contract order [width, height, depth]. */
function formatDimensions(d: Vector3Meters): string {
  const [w, h, depth] = d;
  return `${cm(w)} x ${cm(depth)} x ${cm(h)} cm · ${inches(w)} x ${inches(depth)} x ${inches(h)} in`;
}

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function formatTotals(lines: { priceMinor: number | null; currency: string | null }[]): string {
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (l.priceMinor == null || !l.currency) continue;
    sums.set(l.currency, (sums.get(l.currency) ?? 0) + l.priceMinor);
  }
  if (sums.size === 0) return formatMoney(0, "USD");
  return [...sums].map(([c, v]) => formatMoney(v, c)).join(" + ");
}

/* ---------- small hooks ---------- */

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function readHintSeen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/* ---------- icons ---------- */

const Icon = {
  back: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3 5 8l5 5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 3 2.5 6l3 3" />
      <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  basket: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6h11l-1.2 7a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8z" />
      <path d="M5.5 6 8 2.5 10.5 6" />
    </svg>
  ),
  move: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v12M2 8h12M8 2 6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
    </svg>
  ),
  rotate: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.5 8A4.5 4.5 0 1 1 8 3.5h2.5" />
      <path d="M9 1.5 11 3.5 9 5.5" />
    </svg>
  ),
  unlock: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </svg>
  ),
  arrow: (rot: number) => (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M4 10 8 6l4 4" />
    </svg>
  ),
};

/* ---------- component ---------- */

export function RoomExperience({ room, backHref = "/rooms", onPlanChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const walkRef = useRef<WalkScene | null>(null);
  const retainedPlan = useRef(room.plan);
  const retainedSource = useRef(room.plan);
  const statusRef = useRef<"loading" | "ready" | "error">("loading");
  const anchorRef = useRef<Anchor>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const catalogCloseRef = useRef<HTMLButtonElement>(null);
  const basketCloseRef = useRef<HTMLButtonElement>(null);
  const inventoryCloseRef = useRef<HTMLButtonElement>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // arriving by a page wipe, keep the panel down until the room is built
  useWipeHold(status !== "loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [step, setStep] = useState(0);
  const [items, setItems] = useState<WalkItem[]>([]);
  const [selected, setSelected] = useState<WalkItem | null>(null);
  const [mode, setModeState] = useState<WalkMode>("walk");
  const [locked, setLocked] = useState(false);
  const [moving, setMoving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [xr, setXr] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [, setExploded] = useState(false);
  const [, setBlindsRaised] = useState<boolean | null>(null);
  const [pending, setPending] = useState<ProductCandidate | null>(null);
  const [floorSpot, setFloorSpot] = useState<FloorSpot | null>(null);
  const saveRef = useRef(onPlanChange);
  useLayoutEffect(() => { saveRef.current = onPlanChange; }, [onPlanChange]);
  const previewRef = useRef<(product: ProductCandidate) => void>(() => {});
  const confirmRef = useRef<() => void>(() => {});
  const xrActionRef = useRef<(id: string) => void>(() => {});
  const xrActionPending = useRef(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [agentProposal, setAgentProposal] = useState<PlanProposal | null>(null);
  /** Search results shown beside the room without leaving first person (voice searches land here). */
  const [showResults, setShowResults] = useState(false);
  /** While carrying: does the piece fit where it's held (from the engine, live). */
  const [carry, setCarry] = useState<WalkCarryStatus | null>(null);
  const [swapTarget, setSwapTarget] = useState<WalkItem | null>(null);
  const [category, setCategory] = useState<FurnitureCategory>("chair");
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("300");
  const [merchant, setMerchant] = useState<"IKEA" | "Target">("IKEA");
  const [liveSearch] = useState(true);
  const [searchSpot, setSearchSpot] = useState<FloorSpot | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{ spot: FloorSpot; revision: number; jobId?: string; swapId?: string; raiseBudgetTo?: number } | null>(null);
  const shopping = useRoomShopping({ roomId: `${room.id}-v${ROOM_SESSION_VERSION}`, sourceProjectId: room.plan.projectId, persist: onPlanChange, notice: setNotice });
  const shoppingRef = useRef(shopping);
  useLayoutEffect(() => { shoppingRef.current = shopping; });
  const searchRef = useRef<(spot?: FloorSpot, live?: boolean) => void>(() => {});
  const autoSearch = useRef<string | null>(null);
  const resultsRef = useRef<ShopResult[]>([]);
  const blocked = shopping.busy || shopping.connecting;
  const fetchConnection = useRoomFetch(shopping.session?.plan.projectId);


  const coarse = useMedia("(pointer: coarse)");
  const coarseRef = useRef(coarse);
  const modeRef = useRef<WalkMode>("walk");
  useEffect(() => {
    coarseRef.current = coarse;
    modeRef.current = mode;
  }, [coarse, mode]);

  /* --- selection card placement, written straight to the DOM each frame --- */
  const placeCard = useCallback((anchor: Anchor) => {
    anchorRef.current = anchor;
    const el = cardRef.current;
    if (!el) return;
    if (!anchor || coarseRef.current || window.innerWidth < 768) {
      el.dataset.docked = "true";
      el.style.transform = "";
      return;
    }
    delete el.dataset.docked;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.min(Math.max(anchor.x - w / 2, 16), window.innerWidth - w - 16);
    const y = Math.min(Math.max(anchor.y - h - 20, 84), window.innerHeight - h - 96);
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }, []);

  useLayoutEffect(() => {
    if (selected) placeCard(anchorRef.current);
  }, [selected, coarse, placeCard]);

  /* --- panels --- */
  const openPanel = useCallback((next: Exclude<Panel, null>) => {
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
    walkRef.current?.setMoveInput({ forward: 0, right: 0 });
    setPanel(next);
  }, []);

  const openCatalog = useCallback(() => {
    setSwapTarget(null);
    openPanel("catalog");
  }, [openPanel]);

  const closePanel = useCallback(() => {
    setPanel(null);
    setSwapTarget(null);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    // back to first person, so the shopper doesn't have to click into the room again
    if (modeRef.current === "walk" && !coarseRef.current) walkRef.current?.lockPointer();
  }, []);

  useEffect(() => {
    // the panel is still sliding in from off screen; scrolling to it would shove the whole room sideways
    if (panel === "catalog") catalogCloseRef.current?.focus({ preventScroll: true });
    if (panel === "basket") basketCloseRef.current?.focus({ preventScroll: true });
    if (panel === "inventory") inventoryCloseRef.current?.focus({ preventScroll: true });
  }, [panel]);

  // Esc closes the open panel before the engine sees it; engine keys are held back too.
  useEffect(() => {
    if (blocked) walkRef.current?.setMoveInput({ forward: 0, right: 0 });
    if (!panel && !blocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panel && !blocked) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePanel();
        return;
      }
      if (ENGINE_KEYS.has(e.key.toLowerCase())) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [panel, blocked, closePanel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (panel || e.repeat || e.metaKey || e.ctrlKey || e.altKey || (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      const open = { KeyB: "basket", KeyI: "inventory", KeyF: "catalog" } as const;
      if (e.code in open) {
        e.preventDefault();
        setShowResults(false);
        openPanel(open[e.code as keyof typeof open]);
        return;
      }
      const n = /^Digit([1-9])$/.exec(e.code);
      if (!n) return;
      const slot = Number(n[1]) - 1;
      if (showResultsRef.current) {
        const result = resultsRef.current[slot];
        if (result && slot < 5) { e.preventDefault(); quickAddRef.current(result); }
        return;
      }
      const stashed = inventoryRef.current[slot];
      if (stashed) { e.preventDefault(); carryOutRef.current(stashed); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, openPanel]);
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    const sync = () => setLooking(Boolean(document.pointerLockElement));
    document.addEventListener("pointerlockchange", sync);
    const onTab = (e: KeyboardEvent) => {
      if (e.code !== "Tab" || e.repeat || panel || modeRef.current !== "walk" || coarseRef.current) return;
      e.preventDefault();
      if (document.pointerLockElement) document.exitPointerLock();
      else walkRef.current?.lockPointer();
    };
    window.addEventListener("keydown", onTab);
    return () => { document.removeEventListener("pointerlockchange", sync); window.removeEventListener("keydown", onTab); };
  }, [panel]);
  const showResultsRef = useRef(false);
  const inventoryRef = useRef<WalkItem[]>([]);
  const carryOutRef = useRef<(item: WalkItem) => void>(() => {});
  useLayoutEffect(() => { showResultsRef.current = showResults && !panel; });

  /* --- engine --- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    if (retainedSource.current !== room.plan) { retainedSource.current = room.plan; retainedPlan.current = room.plan; }
    setStatus("loading");
    setPending(null);
    setExploded(false);
    setBlindsRaised(null);
    let walk: WalkScene | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lite = window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches;
    const refreshUndo = () => setCanUndo(walkRef.current?.canUndo() ?? false);

    const callbacks: WalkCallbacks = {
      onReady(next) {
        if (cancelled) return;
        setItems(next);
        refreshUndo();
      },
      onItemsChange(next) {
        if (cancelled) return;
        setItems(next);
        setSelected((prev) => (prev ? (next.find((i) => i.id === prev.id) ?? null) : null));
        setMoving(false);
        refreshUndo();
        setPending(null);
        if (walkRef.current) {
          const snapshot = walkRef.current.getPlan();
          retainedPlan.current = snapshot;
          if (shoppingRef.current.session) void shoppingRef.current.sync(snapshot).catch(() => undefined);
          else saveRef.current?.(snapshot).catch((cause) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : "Could not save this edit."); });
        }
      },
      onPlanApplied(next) {
        if (cancelled) return;
        setItems(next); setSelected((previous) => previous ? next.find((item) => item.id === previous.id) ?? null : null);
        setMoving(false); refreshUndo();
        if (walkRef.current) retainedPlan.current = walkRef.current.getPlan();
      },
      onMoveChange(value) { if (!cancelled) setMoving(value); },
      onProductPreviewChange(preview) { if (!cancelled && !preview) setPending(null); },
      onExplodeChange(value) { if (!cancelled) { setExploded(value); setPending(null); } },
      onWindowBlindsChange(value) { if (!cancelled) setBlindsRaised(value); },
      onCarryStatus(status) { if (!cancelled) setCarry(status); },
      onShoppingFloor(spot) { if (!cancelled) { setFloorSpot(spot); setNotice("Shopping spot selected. Checking pieces that fit here."); searchRef.current(spot, false); } },
      onPreviewOffer(id) { const product = resultsRef.current.find((result) => result.product.id === id)?.product; if (product) previewRef.current(product); },
      onConfirmOffer() { confirmRef.current(); },
      onXRAction(id) { if (!cancelled) xrActionRef.current(id); },
      onXRChange(value) { if (!cancelled) setPresenting(value); },
      onSelect(selection) {
        if (cancelled) return;
        anchorRef.current = selection?.anchor ?? null;
        setSelected(selection?.item ?? null);
        if (!selection) setMoving(false);
      },
      onAnchor(anchor) {
        placeCard(anchor);
      },
      onModeChange(nextMode, pointerLocked) {
        if (cancelled) return;
        setModeState(nextMode);
        setLocked(pointerLocked);
        if (pointerLocked) {
          setPanel(null);
          setSwapTarget(null);
          setHintSeen(true);
          try {
            window.localStorage.setItem(HINT_KEY, "1");
          } catch {
            /* private mode: the hint simply shows again next time */
          }
        }
      },
      onError(message) {
        if (cancelled) return;
        if (walkRef.current && statusRef.current === "ready") {
          setNotice(message);
        } else {
          setErrorMessage(message);
          setStatus("error");
        }
      },
    };

    (async () => {
      try {
        const { createWalkScene } = await import("../room/walk-scene");
        if (cancelled) return;
        const scene: WalkScene = createWalkScene(canvas, retainedPlan.current, callbacks, {
          reducedMotion,
          lite,
          environment: room.environment,
          reconstruction: room.reconstruction,
        });
        walk = scene;
        walkRef.current = scene;
        await scene.ready;
        if (cancelled) return;
        statusRef.current = "ready";
        setStatus("ready");
        refreshUndo();
        void shoppingRef.current.connect(scene);
        scene
          .xrSupported()
          .then((ok) => !cancelled && setXr(ok))
          .catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "Something went wrong while building the room.");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      shoppingRef.current.disconnect();
      if (walk) { walk.cancelMove(); walk.cancelProductPreview(); retainedPlan.current = walk.getPlan(); }
      walk?.dispose();
      walkRef.current = null;
      statusRef.current = "loading";
    };
  }, [room.id, room.plan, room.environment, room.reconstruction, placeCard]);

  // Quiet progress copy while the room builds. There is no real progress signal, so no percentages.
  useEffect(() => {
    if (status !== "loading") return;
    const t = window.setInterval(() => setStep((s) => (s + 1) % LOADING_STEPS.length), 1500);
    return () => window.clearInterval(t);
  }, [status]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* --- actions --- */
  const api = () => walkRef.current;

  const setMode = (next: WalkMode) => {
    if (next === mode) return;
    api()?.cancelProductPreview();
    setPending(null);
    api()?.setMode(next);
  };

  const onCanvasClick = () => {
    if (status !== "ready" || mode !== "walk" || locked || coarse || panel || pending) return;
    api()?.lockPointer();
  };

  const onCanvasPointerDown = () => {
    if (coarse && !hintSeen) setHintSeen(true);
  };

  const enterXR = () => {
    api()
      ?.enterXR()
      .catch(() => setNotice("Could not start VR. Check that the headset browser allows it."));
  };

  const beginMove = (item: WalkItem) => {
    api()?.beginMove(item.id);
    setMoving(true);
    if (mode === "walk" && !coarse) api()?.lockPointer();
  };

  const confirmMove = () => {
    if (api()?.confirmMove()) setMoving(false);
  };

  const cancelMove = () => {
    api()?.cancelMove();
    setMoving(false);
  };

  const remove = (item: WalkItem) => {
    api()?.remove(item.id);
    setNotice(`Removed ${item.label}`);
  };

  /** Moving, turning or stashing your own piece by hand is all the permission it needs. */
  const unlockFor = (item: WalkItem) => { if (item.locked) api()?.setLocked(item.id, false); };

  const putAway = (item: WalkItem) => {
    api()?.store(item.id);
    setNotice(`Put away ${item.label}`);
  };

  const carryOut = (item: WalkItem) => {
    const engine = api();
    if (!engine) return;
    unlockFor(item);
    // straight into your hands; the fit is checked when you set it down
    if (!engine.takeOutAndCarry(item.id)) return;
    setMoving(true);
    if (mode === "walk" && !coarse) engine.lockPointer();
  };

  const takeOut = (item: WalkItem) => {
    const id = api()?.takeOut(item.id);
    if (!id) return;
    setNotice(`Took out ${item.label}`);
    setPanel(null);
    openerRef.current = null;
  };


  const runSearch = (overrideSpot?: FloorSpot, browseLive = liveSearch) => {
    const engine = api();
    if (!engine || !shopping.session || blocked) return;
    const cap = maxPrice.trim() ? Number(maxPrice) : undefined;
    if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0 || cap > 100000)) { setNotice("Choose a price cap between $0.01 and $100,000."); return; }
    try {
      const target = swapTarget ? engine.getPlan().items.find((item) => item.id === swapTarget.id && !item.stored) : null;
      if (swapTarget && !target) throw new Error("The piece to replace is no longer in the room.");
      const spot: FloorSpot = target ? { roomId: target.roomId, position: [...target.position], rotationY: target.rotationY }
        : overrideSpot ?? floorSpot ?? engine.getShoppingSpot();
      setSearchSpot(spot);
      void shopping.search({ category, spot, maxPriceUsd: cap, merchant, request: query.trim() || undefined, live: browseLive }).catch(() => undefined);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Pick a floor spot inside the room."); }
  };
  useLayoutEffect(() => { searchRef.current = runSearch; });

  const addProduct = (candidate: ProductCandidate) => {
    const engine = api(), session = shopping.session;
    if (!engine || !session || blocked) return false;
    const result = resultsRef.current.find((entry) => entry.product.id === candidate.id);
    if (!result?.fits || !result.placement || !searchSpot) { setNotice("Search this room for a fitting piece first."); return false; }
    const product = result.product;
    try {
      engine.cancelProductPreview(); setPending(null);
      engine.previewProduct(product, { swapId: swapTarget?.id, placement: result.placement });
      setPendingPlacement({ spot: swapTarget ? { roomId: result.placement.roomId, position: [...result.placement.position], rotationY: result.placement.rotationY } : searchSpot,
        revision: session.plan.revision, jobId: shopping.job?.id, swapId: swapTarget?.id, raiseBudgetTo: budgetFor(result) ?? undefined });
      setPending(product);
      setNotice(null);
      setPanel(null); openerRef.current = null;
      return true;
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "That piece could not be previewed."); return false; }
  };
  useLayoutEffect(() => { previewRef.current = addProduct; });

  const confirmProduct = () => {
    if (!pending || !pendingPlacement || blocked) return;
    const engine = api();
    const raise = pendingPlacement.raiseBudgetTo;
    // the shopper chose a piece over budget with the raise shown on the button: raise it, then place
    void (raise ? shopping.setBudget(raise).then((plan) => plan.revision) : Promise.resolve(pendingPlacement.revision))
      .then((revision) => shopping.place(pending.id, pendingPlacement.spot, revision, pendingPlacement.jobId, pendingPlacement.swapId)).then(() => {
      if (!engine || api() !== engine) return;
      setPending(null); setPendingPlacement(null); setSwapTarget(null);
      setNotice("Added to the room and your basket.");
    }).catch(() => { if (engine && api() === engine) { engine.cancelProductPreview(); setPending(null); setPendingPlacement(null); } });
  };
  useLayoutEffect(() => { confirmRef.current = confirmProduct; });

  const cancelProduct = () => { api()?.cancelProductPreview(); setPending(null); setPendingPlacement(null); setSwapTarget(null); };
  const assistantSpot = (): FloorSpot => {
    const engine = api();
    if (!engine) throw new Error("The room is not ready yet.");
    return floorSpot ?? engine.getShoppingSpot();
  };
  const assistantSearch = async (request: Omit<ShopRequest, "spot">) => {
    if (blocked || !shopping.session) throw new Error("Wait for this room to finish its current action.");
    cancelProduct();
    const spot = assistantSpot();
    setSearchSpot(spot); setCategory(request.category); setQuery(request.request ?? "");
    if (request.merchant === "IKEA" || request.merchant === "Target") setMerchant(request.merchant);
    setMaxPrice(request.maxPriceUsd != null ? String(request.maxPriceUsd) : "");
    setShowResults(true);
    await shopping.search({ ...request, spot });
  };
  const proposeWithAssistant = async (request: string) => {
    const owner = shopping.session?.plan.projectId;
    setAgentProposal(null);
    if (panel !== "assistant") openPanel("assistant");
    const proposal = await shopping.propose(request, selected?.id ?? null);
    if (shoppingRef.current.session?.plan.projectId !== owner || !walkRef.current) throw new Error("This room assistant session has ended.");
    setAgentProposal(proposal);
    return proposal;
  };
  const quickAdd = (result: ShopResult) => {
    const job = shopping.job, session = shopping.session;
    if (!job?.output || !session || blocked || !result.fits || !result.placement) return;
    const raise = budgetFor(result);
    void (raise ? shopping.setBudget(raise).then((plan) => plan.revision) : Promise.resolve(session.plan.revision))
      .then((revision) => shopping.place(result.product.id, job.output!.request.spot, revision, job.id))
      .then(() => setNotice(`Added ${result.product.label.split(",")[0]}`))
      .catch(() => undefined);
  };
  const quickAddRef = useRef(quickAdd);
  useLayoutEffect(() => { quickAddRef.current = quickAdd; });
  const agentProposalRef = useRef<PlanProposal | null>(null);
  useLayoutEffect(() => { agentProposalRef.current = agentProposal; });
  const proposeByVoice = async (request: string) => {
    const proposal = await shopping.propose(request, selected?.id ?? null);
    setAgentProposal(proposal);
    agentProposalRef.current = proposal;
    return proposal;
  };
  const applyByVoice = async (proposalId: string) => {
    const proposal = agentProposalRef.current;
    if (!proposal || proposal.id !== proposalId) throw new Error("That proposal is gone. Plan it again.");
    await shopping.applyProposal(proposal);
    setAgentProposal(null);
    agentProposalRef.current = null;
  };
  const placeByVoice = async (result: ShopResult, job: Job<ShopJobOutput>) => {
    const session = shoppingRef.current.session;
    if (!session || !job.output) throw new Error("The room isn't connected.");
    cancelProduct();
    await shopping.place(result.product.id, job.output.request.spot, session.plan.revision, job.id);
  };
  const previewFromFetch = async (job: Job<ShopJobOutput>, productId: string) => {
    const owner = shopping.session?.plan.projectId;
    if (blocked || !owner || job.projectId !== owner || !job.output) return false;
    const plan = await shopping.refresh();
    if (shoppingRef.current.session?.plan.projectId !== owner || !api()) return false;
    const found = job.output.results.find((result) => result.product.id === productId);
    if (!found) throw new Error("Ask Fetch to search for this piece again.");
    const product = plan.products.find((entry) => entry.id === productId) ?? found.product;
    const result = evaluate(plan, product, job.output.request, found.source);
    if (!result.fits || !result.placement || result.withinBudget === false) throw new Error(result.problems.join(" ") || "This piece no longer fits this room and budget.");
    const engine = api()!;
    engine.cancelProductPreview();
    engine.previewProduct(product, { placement: result.placement });
    setSearchSpot(job.output.request.spot); setSwapTarget(null);
    setPendingPlacement({ spot: job.output.request.spot, revision: plan.revision, jobId: job.id });
    setPending(product); setPanel(null); openerRef.current = null;
    setNotice(`Previewing ${product.label} from Fetch. Confirm placement to add it to this room.`);
    return true;
  };
  const safely = (action: () => void) => {
    if (blocked) return;
    try { action(); } catch (err) { setNotice(err instanceof Error ? err.message : "That change could not be made."); }
  };
  /* --- derived --- */
  const basket = useMemo(
    () => items.filter((i) => !i.stored && i.productId && i.priceMinor != null && i.origin !== "existing_owned"),
    [items],
  );
  const inventory = useMemo(() => items.filter((i) => i.stored), [items]);
  useLayoutEffect(() => { inventoryRef.current = inventory; carryOutRef.current = (item) => { try { carryOut(item); } catch (err) { setNotice(err instanceof Error ? err.message : "Couldn't pick that up."); } }; });
  const basketTotal = formatTotals(basket);
  const xrActions = useMemo(() => roomXRActions({ connected: Boolean(shopping.session), busy: blocked, pending: Boolean(pending), moving, selected }), [shopping.session, blocked, pending, moving, selected]);
  useLayoutEffect(() => {
    xrActionRef.current = (id) => {
      if (xrActionPending.current || !xrActions.some((action) => action.id === id && !action.disabled)) return;
      if (id === "cancel-preview") { cancelProduct(); setNotice("Preview cancelled. Nothing was added."); return; }
      const request = roomXRSearch(id, merchant);
      xrActionPending.current = true;
      void (async () => {
        if (request) {
          setNotice(`Finding ${CATEGORY_LABEL[request.category].toLowerCase()} that fit your floor spot…`);
          await assistantSearch(request);
          setNotice(null);
        } else if (selected && !selected.locked && !selected.stored) {
          // Use the same server-owned queue as the room assistant. The service
          // rechecks locks, geometry and the current canonical room before saving.
          if (id === "rotate-selected") {
            const item = shopping.session?.plan.items.find((entry) => entry.id === selected.id && !entry.stored);
            if (!item) throw new Error("Select a piece that is still in this room.");
            await shopping.moveAgentItem(item.id, { roomId: item.roomId, position: [...item.position], rotationY: item.rotationY + ROTATE_STEP });
            setNotice(`Rotated ${item.label}; position checked to fit this room.`);
          } else if (id === "store-selected") {
            await shopping.storeAgentItem(selected.id);
            setNotice(`Put away ${selected.label}. It is kept in your inventory.`);
          }
        }
      })().catch((cause) => setNotice(cause instanceof Error ? cause.message : "That headset action could not be completed."))
        .finally(() => { xrActionPending.current = false; });
    };
  });



  const categories = Object.keys(CATEGORY_LABEL) as FurnitureCategory[];
  function budgetFor(result: ShopResult): number | null {
    const budget = shopping.session?.plan.constraints.budget;
    if (result.withinBudget !== false || !budget || result.overBudgetUsd == null) return null;
    return Math.ceil((budget.amountMinor + Math.round(result.overBudgetUsd * 100)) / 5000) * 5000;
  }
  const results = useMemo(() => {
    const output = shopping.job?.output, plan = shopping.session?.plan;
    if (!output || !plan) return [];
    const target = swapTarget ? plan.items.find((item) => item.id === swapTarget.id && !item.stored) : null;
    const searchPlan = target ? { ...plan, items: plan.items.filter((item) => item.id !== target.id) } : plan;
    return output.results.map((entry) => {
      const product = plan.products.find((known) => known.id === entry.product.id) ?? entry.product;
      const result = evaluate(searchPlan, product, output.request, entry.source);
      if (!target) return result;
      const exact = placeAt(searchPlan, product, { roomId: target.roomId, position: [...target.position], rotationY: target.rotationY }, { maxShiftM: 0, fallback: false });
      return { ...result, fits: result.fits && exact.ok && !target.locked,
        placement: exact.ok ? exact.placement : null,
        problems: target.locked ? ["Unlock this piece before replacing it."] : exact.ok ? result.problems : [...result.problems, exact.message] };
    });
  }, [shopping.job, shopping.session, swapTarget]);
  useLayoutEffect(() => { resultsRef.current = results; }, [results]);
  const connectedProject = shopping.session?.plan.projectId;
  // Fetch adds public catalog observations, never an accepted placement. Refresh
  // through the same queue after local drags/previews finish, preserving the camera.
  const fetchJob = fetchConnection.status?.job;
  const fetchRevision = fetchJob?.output?.checkedAtRevision;
  const fetchAttempt = useRef({ key: "", at: 0 });
  const canonicalRevision = shopping.session?.plan.revision;
  const refreshRoom = shopping.refresh;
  useEffect(() => {
    const key = `${connectedProject}:${fetchRevision}`;
    if (blocked || pending || moving || fetchRevision == null || canonicalRevision == null || fetchRevision <= canonicalRevision || (fetchAttempt.current.key === key && Date.now() - fetchAttempt.current.at < 5000)) return;
    fetchAttempt.current = { key, at: Date.now() };
    void refreshRoom().catch(() => undefined);
  }, [blocked, pending, moving, fetchJob, fetchRevision, connectedProject, canonicalRevision, refreshRoom]);

  useEffect(() => {
    if (panel !== "catalog" || !connectedProject) { autoSearch.current = null; return; }
    if (connectedProject && !shopping.job && !blocked && autoSearch.current !== connectedProject) { autoSearch.current = connectedProject; searchRef.current(); }
  }, [panel, connectedProject, shopping.job, blocked]);

  useEffect(() => {
    if (status !== "ready") return;
    walkRef.current?.setXRShopping({
      offers: roomXRProducts(results, pending).map(({ product: p, source }) => ({ id: p.id, label: p.label, detail: p.price ? `${formatMoney(p.price.amountMinor, p.price.currency)} · ${p.merchant} · ${source === "live" ? "live search" : source === "catalog" ? "catalog" : "preview"}` : p.merchant })),
      selectedItemLabel: selected?.label, selectedItemLocked: selected?.locked, pendingOfferId: pending?.id, canConfirm: Boolean(pending) && !blocked,
      busy: blocked, basketLabel: `Basket ${basket.length} · ${basketTotal}`,
      actions: xrActions,
      status: blocked ? "Updating your room…" : notice ?? shopping.job?.stage ?? "Point at clear floor to choose where you shop.",
    });
  }, [status, results, selected, pending, notice, blocked, shopping.job, shopping.session, moving, basket.length, basketTotal, xrActions]);

  const ready = status === "ready";
  const showHint = ready && mode === "walk" && !hintSeen && !panel;

  return (
    <div
      className="room-x"
      data-ready={ready || undefined}
      data-shopping={shopping.session ? "connected" : shopping.connecting ? "connecting" : "offline"}
      data-mode={mode}
      data-locked={locked || undefined}
      data-touch={coarse || undefined}
      data-syncing={blocked || undefined}
    >
      <canvas
        ref={canvasRef}
        className="room-x__canvas"
        data-tour="room"
        role="img"
        aria-label={`${room.label}, walkable view`}
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
      />

      {/* only when the room can't reach the server; action errors show as notices */}
      {!shopping.session ? <div className="room-x__connection" role="status">
        {shopping.connecting ? "Connecting…" : shopping.error ? <>{shopping.error} <button type="button" onClick={() => { const engine = api(); if (engine) void shopping.connect(engine); }}>Retry</button></> : "Offline"}
      </div> : null}
      {/* ---------- top bar ---------- */}
      <header className="room-x__bar">
        <div className="room-x__start">
          <WipeLink className="room-x__pill room-x__home" href="/" aria-label="tadaima home">
            <Image src={mark} alt="" className="room-x__mark" priority />
          </WipeLink>
          <WipeLink className="room-x__pill room-x__back" href={backHref} aria-label="Back to rooms">
            {Icon.back}
            <span className="room-x__back-text">Rooms</span>
          </WipeLink>
        </div>

        <h1 className="room-x__title" title={room.sourceDescription ?? "Demo room"}>{room.label}</h1>

        <div className="room-x__bar-end">
          <div className="room-x__modes">
            <div className="room-x__toggle" role="group" aria-label="View" data-mode={mode}>
              <button type="button" aria-pressed={mode === "walk"} onClick={() => setMode("walk")} disabled={!ready || blocked}>
                Walk
              </button>
              <button type="button" aria-pressed={mode === "orbit"} onClick={() => setMode("orbit")} disabled={!ready || blocked}>
                Dollhouse
              </button>
            </div>
            {xr && ready ? (
              <button type="button" className="room-x__pill" onClick={enterXR}>
                Enter VR
              </button>
            ) : null}
          </div>

          <button
            type="button"
            data-tour="basket"
            className="room-x__pill room-x__basket-btn"
            onClick={() => openPanel("basket")}
            aria-haspopup="dialog"
            aria-expanded={panel === "basket"}
            aria-label={`Basket, ${basket.length} ${basket.length === 1 ? "piece" : "pieces"}, ${basketTotal}`}
            title="Basket (B)"
            disabled={!ready || blocked}
          >
            {Icon.basket}
            <span className="room-x__basket-total">{basket.length ? basketTotal : "$0"}</span>
          </button>
        </div>
      </header>

      {/* ---------- walk aids ---------- */}

      {coarse ? (
        <p className="room-x__hint" data-show={showHint || undefined} aria-hidden={!showHint}>
          Drag to look around. Use the pad to walk. Tap a piece to select it.
        </p>
      ) : null}
      {ready && !coarse && mode === "walk" && !panel ? (
        <p className="room-x__cursor-chip" data-looking={looking || undefined}>
          {looking ? <>Press <span className="room-x__cap-key">Tab</span> for your cursor</> : <>Click the room or press <span className="room-x__cap-key">Tab</span> to look around</>}
        </p>
      ) : null}

      {ready && coarse && mode === "walk" ? (
        <div className="room-x__pad" role="group" aria-label="Walk">
          {(
            [
              ["w", "Forward", 0, "up"],
              ["a", "Left", -90, "left"],
              ["d", "Right", 90, "right"],
              ["s", "Back", 180, "down"],
            ] as const
          ).map(([key, label, rot, area]) => (
            <button
              key={key}
              type="button"
              className="room-x__pad-btn"
              data-area={area}
              aria-label={`Walk ${label.toLowerCase()}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                api()?.setMoveInput({ forward: key === "w" ? 1 : key === "s" ? -1 : 0, right: key === "d" ? 1 : key === "a" ? -1 : 0 });
              }}
              onPointerUp={() => api()?.setMoveInput({ forward: 0, right: 0 })}
              onPointerCancel={() => api()?.setMoveInput({ forward: 0, right: 0 })}
              onLostPointerCapture={() => api()?.setMoveInput({ forward: 0, right: 0 })}
              onContextMenu={(e) => e.preventDefault()}
            >
              {Icon.arrow(rot)}
            </button>
          ))}
        </div>
      ) : null}

      {/* ---------- bottom tools ---------- */}
      {ready ? (
        <div className="room-x__bottom"><div className="room-x__tools">
          <button
            type="button"
            className="room-x__pill"
            data-tour="undo"
            onClick={() => safely(() => api()?.undo())}
            disabled={!canUndo || blocked}
            aria-label="Undo last change"
          >
            {Icon.undo}
            <span className="room-x__tools-text">Undo</span>
          </button>
          <RoomVoice key={shopping.session?.plan.projectId ?? "offline"}
            plan={shopping.session?.plan ?? null} selectedId={selected?.id ?? null} job={shopping.job} results={results}
            available={Boolean(shopping.session?.capabilities.voice)} liveSearch={Boolean(shopping.session?.capabilities.liveSearch)}
            getSpot={assistantSpot} onRefresh={shopping.refresh} onPropose={proposeByVoice}
            onApply={applyByVoice} getProposal={() => agentProposalRef.current} onSetBudget={shopping.setBudget}
            onSearch={assistantSearch} onPreview={(result) => addProduct(result.product)} onPlace={placeByVoice}
            onMove={shopping.moveAgentItem} onStore={shopping.storeAgentItem} disabled={presenting}
          />
          <button
            type="button"
            className="room-x__pill room-x__pill--ink"
            data-tour="add"
            title="Add furniture (F)"
            onClick={openCatalog}
            disabled={blocked || !shopping.session}
            aria-haspopup="dialog"
            aria-expanded={panel === "catalog" && !swapTarget}
          >
            {Icon.plus}
            <span>Add furniture</span>
          </button>
        </div>
          {/* hotbar: stashed pieces wait in numbered slots; press the number or click to pick one up */}
          <div className="room-x__hotbar" data-tour="inventory" role="list" aria-label="Inventory">
            {Array.from({ length: HOTBAR_SLOTS }, (_, i) => {
              const item = inventory[i];
              return item ? (
                <button key={item.id} type="button" role="listitem" className="room-x__slot" data-filled disabled={blocked}
                  onClick={() => safely(() => carryOut(item))} aria-label={`Slot ${i + 1}: ${item.label.split(",")[0]}. Pick up`}>
                  <CategoryGlyph category={item.category} />
                  <span className="room-x__slot-n">{i + 1}</span>
                  <span className="room-x__slot-tip" role="tooltip">
                    {item.label.split(",")[0]}
                    <small>{formatDimensions(item.dimensions).split(" · ")[0]}</small>
                  </span>
                </button>
              ) : (
                <span key={`empty-${i}`} role="listitem" className="room-x__slot" aria-label={`Slot ${i + 1}: empty`}>
                  <span className="room-x__slot-n">{i + 1}</span>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {pending && ready ? <div className="room-x__placement" role="region" aria-label="Confirm furniture placement">
        <strong>{pending.label.split(",")[0]}</strong><p>{pending.price ? formatMoney(pending.price.amountMinor, pending.price.currency) : "Price unknown"}{pendingPlacement?.raiseBudgetTo ? ` · raises your budget to ${formatMoney(pendingPlacement.raiseBudgetTo, "USD")}` : ""}</p>
        <div><button type="button" className="room-x__chip-btn" onClick={cancelProduct}>Cancel</button><button type="button" className="room-x__chip-btn room-x__chip-btn--ink" onClick={confirmProduct} disabled={blocked}>Add to room</button></div>
      </div> : null}
      {/* ---------- selected piece: a small toolbar over it ---------- */}
      {selected && ready && !pending && !moving ? (
        <div ref={cardRef} className="room-x__toolbar" role="toolbar" aria-label={`Edit ${selected.label}`}>
          <button type="button" className="room-x__tool" onClick={() => safely(() => { unlockFor(selected); beginMove({ ...selected, locked: false }); })} aria-label="Pick up and move" title="Move (G)">
            {Icon.move}<span className="room-x__key">G</span>
          </button>
          <button type="button" className="room-x__tool" onClick={() => safely(() => { unlockFor(selected); api()?.rotate(selected.id, ROTATE_STEP); })} aria-label="Rotate" title="Rotate (R)">
            {Icon.rotate}<span className="room-x__key">R</span>
          </button>
          <button type="button" className="room-x__tool" onClick={() => safely(() => { unlockFor(selected); putAway(selected); })} aria-label="Put away in inventory" title="Put away (Del)">
            {Icon.close}<span className="room-x__key">Del</span>
          </button>
        </div>
      ) : null}

      {/* ---------- the selected piece's details, above the hotbar ---------- */}
      {selected && ready && !pending && !moving ? (
        <div className="room-x__carry room-x__info" role="status" key={selected.id}>
          <strong>{selected.label.split(",")[0]}</strong>
          <span>
            {formatDimensions(selected.dimensions)}
            {selected.priceMinor != null && selected.currency && selected.origin !== "existing_owned" ? ` · ${formatMoney(selected.priceMinor, selected.currency)}` : ""}
          </span>
        </div>
      ) : null}

      {/* ---------- carrying a piece: what it is, bottom center ---------- */}
      {selected && ready && moving ? (
        <div className="room-x__carry" role="status">
          <strong>{selected.label.split(",")[0]}</strong>
          <span>
            {formatDimensions(selected.dimensions)}
            {selected.priceMinor != null && selected.currency ? ` · ${formatMoney(selected.priceMinor, selected.currency)}` : ""}
          </span>
          {carry ? <span className="room-x__carry-fit" data-level={carry.level}>{carry.level === "fits" ? "Fits here" : carry.level === "snap" ? "Will snap into place" : carry.problems[0] ?? "Doesn't fit here"}</span> : null}
          <span className="room-x__carry-hint">{coarse ? "Drag to place it" : "Click to set it down"} · R to rotate · Esc to cancel</span>
          {coarse ? (
            <div>
              <button type="button" className="room-x__chip-btn" onClick={cancelMove}>Cancel</button>
              <button type="button" className="room-x__chip-btn room-x__chip-btn--ink" onClick={() => safely(confirmMove)}>Place here</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------- search results beside the room (no cursor needed) ---------- */}
      {showResults && shopping.job && !panel && ready ? (
        <aside className="room-x__results" aria-label="Search results">
          <div className="room-x__results-head">
            <strong>{shopping.job.output ? `${CATEGORY_LABEL[shopping.job.output.request.category]}${shopping.job.output.request.maxPriceUsd ? ` under $${shopping.job.output.request.maxPriceUsd}` : ""}` : "Searching"}</strong>
            <button type="button" className="room-x__icon-btn" onClick={() => setShowResults(false)} aria-label="Close results">{Icon.close}</button>
          </div>
          {shopping.job.output?.live === "running" ? <p className="room-x__results-stage">Still checking the store…</p> : null}
          {!results.length ? <p className="room-x__results-stage">{shopping.job.output ? "Nothing fits there under that price." : "Looking…"}</p> : null}
          <ol>
            {results.slice(0, 5).map((r, i) => (
              <li key={r.product.id} data-fits={r.fits || undefined}>
                <span className="room-x__results-n">{i + 1}</span>
                <div>
                  <p>{r.product.label.split(",")[0]}</p>
                  <small>
                    {r.product.price ? formatMoney(r.product.price.amountMinor, r.product.price.currency) : "Price unknown"} ·{" "}
                    {!r.fits ? r.problems[0] ?? "doesn't fit" : r.withinBudget === false ? `$${Math.ceil(r.overBudgetUsd ?? 0)} over budget` : "fits"}
                  </small>
                </div>
                {r.fits ? (
                  <button type="button" className="room-x__chip-btn" disabled={blocked} onClick={() => quickAdd(r)}>
                    Add
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {results.some((r) => r.fits) ? <p className="room-x__results-stage">Press 1 to 5, or say “add the first one”.</p> : null}
        </aside>
      ) : null}

      {/* ---------- catalog ---------- */}
      <div
        className="room-x__panel room-x__catalog"
        role="dialog"
        aria-label={swapTarget ? `Swap ${swapTarget.label}` : "Add furniture"}
        data-open={panel === "catalog" || undefined}
        inert={panel !== "catalog"}
      >
        <div className="room-x__panel-head">
          <div>
            <h2 className="room-x__panel-title">{swapTarget ? "Swap a piece" : "Add furniture"}</h2>
            {swapTarget ? <p className="room-x__panel-sub">Replacing {swapTarget.label}.</p> : null}
          </div>
          <button ref={catalogCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        <div className="room-x__chips" role="group" aria-label="What kind of piece">
          {categories.map((c) => (
            <button key={c} type="button" className="room-x__chip" aria-pressed={category === c} onClick={() => { setCategory(c); }}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <form className="room-x__search room-x__search--row" onSubmit={(event) => { event.preventDefault(); runSearch(); }}>
          <input aria-label="Describe it" value={query} maxLength={300} placeholder="Describe it (optional)" onChange={(event) => setQuery(event.target.value)} />
          <label className="room-x__cap">Under $<input aria-label="Max price in dollars" type="number" min="1" max="100000" step="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
          <button type="submit" className="room-x__chip-btn room-x__chip-btn--ink" disabled={blocked || !shopping.session}>Search</button>
        </form>
        {shopping.job ? <p className="room-x__search-status" role="status">{shopping.job.stage}</p> : null}

        {shopping.job && !results.length ? <p className="room-x__empty">Nothing fits there under that price yet. Try a higher price or another spot.</p> : null}
        <ul className="room-x__products">
          {results.map((result) => {
            const p = result.product;
            const known = p.dimensions != null;
            return (
              <li key={p.id} className="room-x__product" data-unknown={!known || undefined}>
                <div className="room-x__product-img">
                  {p.imageUrl ? (
                    // Remote merchant images; next/image has no remote patterns configured here.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  ) : null}
                </div>
                <p className="room-x__product-name"><a href={/^https:\/\//i.test(p.sourceUrl) ? p.sourceUrl : undefined} target="_blank" rel="noreferrer">{p.label.split(",")[0]}</a></p>
                <p className="room-x__product-meta">
                  <span>{p.dimensions ? formatDimensions(p.dimensions).split(" · ")[0] : "Size not listed"}</span>
                  {p.price ? <span className="room-x__product-price">{formatMoney(p.price.amountMinor, p.price.currency)}</span> : null}
                </p>
                <p className="room-x__product-fit" data-ok={result.fits || undefined}>
                  {p.availability === "unavailable" ? "Out of stock" : !result.fits ? result.problems[0] ?? "Doesn't fit here" : result.withinBudget === false ? `Fits · $${Math.ceil(result.overBudgetUsd ?? 0)} over budget` : result.placement?.againstWallId ? "Fits against the wall" : "Fits here"}
                </p>
                {result.fits && known && p.price && p.availability !== "unavailable" ? (
                  <button type="button" className="room-x__chip-btn room-x__chip-btn--ink room-x__product-add" onClick={() => addProduct(p)} disabled={blocked || !ready}>
                    {budgetFor(result) ? `Add · budget to ${formatMoney(budgetFor(result)!, "USD")}` : "Add to room"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <button type="button" className="room-x__text-btn room-x__more" onClick={() => { cancelProduct(); openPanel("assistant"); }} disabled={!shopping.session}>Plan a change by text, or shop with Fetch</button>
      </div>

      {/* ---------- basket ---------- */}
      <div
        className="room-x__panel room-x__basket"
        role="dialog"
        aria-label="Basket"
        data-open={panel === "basket" || undefined}
        inert={panel !== "basket"}
      >
        <div className="room-x__panel-head">
          <div>
            <h2 className="room-x__panel-title">Basket</h2>
          </div>
          <button ref={basketCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        {basket.length === 0 ? (
          <p className="room-x__empty">Nothing yet. Pieces you add to the room land here.</p>
        ) : (
          <ul className="room-x__lines">
            {basket.map((i) => (
              <li key={i.id} className="room-x__line">
                <div className="room-x__line-main">
                  <p className="room-x__line-name">{i.label.split(",")[0]}</p>
                  <p className="room-x__line-dims">{formatDimensions(i.dimensions)}</p>
                </div>
                <div className="room-x__line-end">
                  <p className="room-x__line-price">{formatMoney(i.priceMinor ?? 0, i.currency ?? "USD")}</p>
                  <button type="button" className="room-x__text-btn" onClick={() => remove(i)} aria-label={`Remove ${i.label}`}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="room-x__basket-foot">
          <p className="room-x__total">
            <span>Total</span>
            <span>{basketTotal}</span>
          </p>
          {connectedProject && panel === "basket" && basket.length ? <RoomCheckout projectId={connectedProject} planRevision={shopping.session!.plan.revision} onPlanRefresh={async () => { await shopping.refresh(); }} testPaymentsAvailable={shopping.session!.capabilities.testPayments} /> : null}
        </div>
      </div>

      {/* ---------- inventory ---------- */}
      <div
        className="room-x__panel"
        role="dialog"
        aria-label="Inventory"
        data-open={panel === "inventory" || undefined}
        inert={panel !== "inventory"}
      >
        <div className="room-x__panel-head">
          <div>
            <h2 className="room-x__panel-title">Inventory</h2>
          </div>
          <button ref={inventoryCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        {inventory.length === 0 ? (
          <p className="room-x__empty">Nothing put away.</p>
        ) : (
          <ul className="room-x__lines">
            {inventory.map((i) => (
              <li key={i.id} className="room-x__line">
                <div className="room-x__line-main">
                  <p className="room-x__line-name">{i.label.split(",")[0]}</p>
                  <p className="room-x__line-dims">{formatDimensions(i.dimensions)}</p>
                </div>
                <div className="room-x__line-end">
                  <button type="button" className="room-x__text-btn" onClick={() => safely(() => takeOut(i))} aria-label={`Take out ${i.label}`}>
                    Take out
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {panel === "assistant" && shopping.session ? <RoomAssistant key={shopping.session.plan.projectId} plan={shopping.session.plan} capabilities={shopping.session.capabilities} selectedId={selected?.id ?? null} busy={blocked} job={shopping.job} results={results}
        onClose={closePanel} onBasket={() => openPanel("basket")} onRefresh={shopping.refresh}
        onPropose={proposeWithAssistant} onApply={shopping.applyProposal}
        onSearch={assistantSearch} onPreview={(result) => addProduct(result.product)}
        proposal={agentProposal} onProposal={setAgentProposal} fetchConnection={fetchConnection} onFetchPreview={previewFromFetch} /> : null}
      {room.sourceDescription ? <p className="room-x__source">{room.sourceDescription}</p> : null}
      {/* ---------- states ---------- */}
      <div className="room-x__veil" data-show={status === "loading" || undefined} aria-hidden={status !== "loading"}>
        <p className="room-x__veil-title">{room.label}</p>
        <p className="room-x__veil-step" role="status" key={step}>
          {LOADING_STEPS[step]}
        </p>
        <span className="room-x__veil-line" aria-hidden="true" />
      </div>

      {status === "error" ? (
        <div className="room-x__veil room-x__error" data-show="true" role="alert">
          <p className="room-x__veil-title">This room could not open</p>
          <p className="room-x__veil-step">{errorMessage || "Something went wrong while building the room."}</p>
          <div className="room-x__error-actions">
            <WipeLink className="room-x__pill" href={backHref}>
              Back to rooms
            </WipeLink>
            <button type="button" className="room-x__pill room-x__pill--ink" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}

      <p className="room-x__toast" role="status" aria-live="polite" data-show={notice ? true : undefined}>
        {notice}
      </p>
    </div>
  );
}
