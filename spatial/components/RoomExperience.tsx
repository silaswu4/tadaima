"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FloorSpot, FurnitureCategory, ProductCandidate, RoomPlan, ShopResult, Vector3Meters } from "../../backend/contracts";
import dynamic from "next/dynamic";
import { placeAt } from "../../backend/shopping/placement";
import { evaluate } from "../../backend/shopping/spot";
import { useRoomShopping } from "../rooms/use-room-shopping";
import type { WalkCallbacks, WalkEnvironment, WalkItem, WalkMode, WalkOptions, WalkScene } from "../room/walk-api";
import mark from "../assets/tadaima-mark.png";
import { WipeLink, useWipeHold } from "./PageWipe";
import "./RoomExperience.css";

export type ExperienceRoom = { id: string; label: string; plan: RoomPlan; environment?: WalkEnvironment; reconstruction?: WalkOptions["reconstruction"]; sourceDescription?: string };
type Props = { room: ExperienceRoom; backHref?: string; onPlanChange?: (plan: RoomPlan) => Promise<void> };
type Panel = "catalog" | "basket" | "inventory" | null;
type Anchor = { x: number; y: number } | null;

const RoomCheckout = dynamic(() => import("./RoomCheckout").then((module) => module.RoomCheckout), { loading: () => <p role="status">Loading checkout…</p> });
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
  const [exploded, setExploded] = useState(false);
  const [pending, setPending] = useState<ProductCandidate | null>(null);
  const [floorSpot, setFloorSpot] = useState<FloorSpot | null>(null);
  const saveRef = useRef(onPlanChange);
  useLayoutEffect(() => { saveRef.current = onPlanChange; }, [onPlanChange]);
  const previewRef = useRef<(product: ProductCandidate) => void>(() => {});
  const confirmRef = useRef<() => void>(() => {});
  const [panel, setPanel] = useState<Panel>(null);
  const [swapTarget, setSwapTarget] = useState<WalkItem | null>(null);
  const [category, setCategory] = useState<FurnitureCategory>("chair");
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("300");
  const [merchant, setMerchant] = useState<"IKEA" | "Target">("IKEA");
  const [liveSearch, setLiveSearch] = useState(true);
  const [searchSpot, setSearchSpot] = useState<FloorSpot | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{ spot: FloorSpot; revision: number; jobId?: string; swapId?: string } | null>(null);
  const shopping = useRoomShopping({ roomId: room.id, sourceProjectId: room.plan.projectId, persist: onPlanChange, notice: setNotice });
  const shoppingRef = useRef(shopping);
  useLayoutEffect(() => { shoppingRef.current = shopping; });
  const searchRef = useRef<(spot?: FloorSpot, live?: boolean) => void>(() => {});
  const autoSearch = useRef<string | null>(null);
  const resultsRef = useRef<ShopResult[]>([]);
  const blocked = shopping.busy || shopping.connecting;


  const coarse = useMedia("(pointer: coarse)");
  const coarseRef = useRef(coarse);
  useEffect(() => {
    coarseRef.current = coarse;
  }, [coarse]);

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
    if (opener && opener.isConnected) opener.focus();
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

  /* --- engine --- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    if (retainedSource.current !== room.plan) { retainedSource.current = room.plan; retainedPlan.current = room.plan; }
    setStatus("loading");
    setPending(null);
    setExploded(false);
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
      onShoppingFloor(spot) { if (!cancelled) { setFloorSpot(spot); setNotice("Shopping spot selected. Checking pieces that fit here."); searchRef.current(spot, false); } },
      onPreviewOffer(id) { const product = resultsRef.current.find((result) => result.product.id === id)?.product; if (product) previewRef.current(product); },
      onConfirmOffer() { confirmRef.current(); },
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

  const putAway = (item: WalkItem) => {
    api()?.store(item.id);
    setNotice(`Put away ${item.label}`);
  };

  const takeOut = (item: WalkItem) => {
    const id = api()?.takeOut(item.id);
    if (!id) return;
    setNotice(`Took out ${item.label}`);
    setPanel(null);
    openerRef.current = null;
  };

  const startSwap = (item: WalkItem) => {
    setCategory(item.category);
    setSearchSpot(null);
    shopping.stopSearch();
    openPanel("catalog");
    setSwapTarget(item);
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
    if (!engine || !session || blocked) return;
    const result = resultsRef.current.find((entry) => entry.product.id === candidate.id);
    if (!result?.fits || !result.placement || !searchSpot) { setNotice("Search this room for a fitting piece first."); return; }
    const product = result.product;
    try {
      engine.cancelProductPreview(); setPending(null);
      engine.previewProduct(product, { swapId: swapTarget?.id, placement: result.placement });
      setPendingPlacement({ spot: swapTarget ? { roomId: result.placement.roomId, position: [...result.placement.position], rotationY: result.placement.rotationY } : searchSpot,
        revision: session.plan.revision, jobId: shopping.job?.id, swapId: swapTarget?.id });
      setPending(product);
      setNotice(`Previewing ${product.label}. Confirm placement to add it to this room.`);
      setPanel(null); openerRef.current = null;
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "That piece could not be previewed."); }
  };
  useLayoutEffect(() => { previewRef.current = addProduct; });

  const confirmProduct = () => {
    if (!pending || !pendingPlacement || blocked) return;
    const engine = api();
    void shopping.place(pending.id, pendingPlacement.spot, pendingPlacement.revision, pendingPlacement.jobId, pendingPlacement.swapId).then(() => {
      if (!engine || api() !== engine) return;
      setPending(null); setPendingPlacement(null); setSwapTarget(null);
      setNotice("Added to this room and its server basket. Nothing purchased.");
    }).catch(() => { if (engine && api() === engine) { engine.cancelProductPreview(); setPending(null); setPendingPlacement(null); } });
  };
  useLayoutEffect(() => { confirmRef.current = confirmProduct; });

  /* --- voice: "here" is the picked floor spot, else where the shopper is looking --- */
  const voiceJob = useRef<string | null>(null);
  const voiceSpot = (): FloorSpot | null => {
    try { return floorSpot ?? api()?.getShoppingSpot() ?? null; } catch { return null; }
  };
  const onVoiceShop = (job: Parameters<typeof shopping.showJob>[0]) => {
    shopping.showJob(job);
    if (!job.output || voiceJob.current === job.id) return;
    // first update of a voice search: show its results like a typed one
    voiceJob.current = job.id;
    setSwapTarget(null);
    setCategory(job.output.request.category);
    setSearchSpot(job.output.request.spot);
    setPanel("catalog");
  };
  const onVoicePlaced = (itemId: string) => {
    void shopping.refresh().then(() => api()?.select(itemId)).catch(() => undefined);
  };
  const cancelProduct = () => { api()?.cancelProductPreview(); setPending(null); setPendingPlacement(null); setSwapTarget(null); };
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
  const basketTotal = formatTotals(basket);

  const exportBasket = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ roomId: room.id, room: room.label, previewOnly: true,
      exportedAt: new Date().toISOString(), items: basket.map((item) => ({ ...item, sourceUrl: shopping.session?.plan.products.find((p) => p.id === item.productId)?.sourceUrl ?? null })) }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `tadaima-basket-${room.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };


  const categories = Object.keys(CATEGORY_LABEL) as FurnitureCategory[];
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

  useEffect(() => {
    if (panel !== "catalog" || !connectedProject) { autoSearch.current = null; return; }
    if (connectedProject && !shopping.job && !blocked && autoSearch.current !== connectedProject) { autoSearch.current = connectedProject; searchRef.current(); }
  }, [panel, connectedProject, shopping.job, blocked]);

  useEffect(() => {
    if (status !== "ready") return;
    walkRef.current?.setXRShopping({
      offers: results.filter((entry) => entry.fits).slice(0, 3).map(({ product: p, source }) => ({ id: p.id, label: p.label, detail: p.price ? `${formatMoney(p.price.amountMinor, p.price.currency)} · ${p.merchant} · ${source === "live" ? "live search" : "catalog"}` : p.merchant })),
      selectedItemLabel: selected?.label, pendingOfferId: pending?.id, canConfirm: Boolean(pending) && !blocked,
      status: blocked ? "Saving with room service…" : notice ?? shopping.job?.stage ?? "Search on the page, then preview and confirm furniture here. Trigger selects a spot; left stick teleports.",
    });
  }, [status, results, selected, pending, notice, blocked, shopping.job]);

  const ready = status === "ready";
  const showHint = ready && mode === "walk" && !hintSeen && !panel;

  return (
    <div
      className="room-x"
      data-ready={ready || undefined}
      data-mode={mode}
      data-locked={locked || undefined}
      data-touch={coarse || undefined}
      data-syncing={blocked || undefined}
    >
      <canvas
        ref={canvasRef}
        className="room-x__canvas"
        role="img"
        aria-label={`${room.label}, walkable view`}
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
      />

      <div className="room-x__connection" role="status">
        {shopping.connecting ? "Connecting room shopping…" : shopping.error ? <>{shopping.error} <button type="button" onClick={() => { const engine = api(); if (engine) void shopping.connect(engine); }}>Retry connection</button></> : shopping.session ? `Shopping connected · ${shopping.session.capabilities.persistence === "memory" ? "local server session" : "saved server room"}` : "Room shopping is offline"}
      </div>
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
            <button type="button" className="room-x__pill" aria-pressed={exploded} disabled={!ready || presenting} onClick={() => { api()?.setExploded(!exploded); }}>Explode</button>
            {xr && ready ? (
              <button type="button" className="room-x__pill" onClick={enterXR}>
                Enter VR
              </button>
            ) : null}
          </div>

          {inventory.length > 0 ? (
            <button
              type="button"
              className="room-x__pill room-x__basket-btn"
              onClick={() => openPanel("inventory")}
              aria-haspopup="dialog"
              aria-expanded={panel === "inventory"}
              aria-label={`Inventory, ${inventory.length} ${inventory.length === 1 ? "piece" : "pieces"} put away`}
              disabled={!ready || blocked}
            >
              <span>Inventory</span>
              <span className="room-x__count">{inventory.length}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="room-x__pill room-x__basket-btn"
            onClick={() => openPanel("basket")}
            aria-haspopup="dialog"
            aria-expanded={panel === "basket"}
            aria-label={`Basket, ${basket.length} ${basket.length === 1 ? "piece" : "pieces"}, ${basketTotal}`}
            disabled={!ready || blocked}
          >
            <span>Basket</span>
            {basket.length > 0 ? (
              <>
                <span className="room-x__count">{basket.length}</span>
                <span className="room-x__basket-total">{basketTotal}</span>
              </>
            ) : null}
          </button>
        </div>
      </header>

      {/* ---------- walk aids ---------- */}

      <p className="room-x__hint" data-show={showHint || undefined} aria-hidden={!showHint}>
        {coarse
          ? "Drag to look around. Use the pad to walk. Tap a piece to select it."
          : "Click to look around. WASD to walk. Click a piece to select it."}
      </p>

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
        <div className="room-x__tools">
          <button
            type="button"
            className="room-x__pill"
            onClick={() => safely(() => api()?.undo())}
            disabled={!canUndo || blocked}
            aria-label="Undo last change"
          >
            {Icon.undo}
            <span className="room-x__tools-text">Undo</span>
          </button>
          <RoomVoice
            projectId={shopping.session?.plan.projectId ?? null}
            getSpot={voiceSpot}
            getSelectedItemId={() => selected?.id ?? null}
            onPlanChanged={() => void shopping.refresh().catch(() => undefined)}
            onShop={onVoiceShop}
            onPlaced={onVoicePlaced}
            disabled={presenting}
          />
          <button
            type="button"
            className="room-x__pill room-x__pill--ink"
            onClick={openCatalog}
            disabled={blocked || !shopping.session}
            aria-haspopup="dialog"
            aria-expanded={panel === "catalog" && !swapTarget}
          >
            {Icon.plus}
            <span>Add furniture</span>
          </button>
        </div>
      ) : null}

      {pending && ready ? <div className="room-x__placement" role="region" aria-label="Confirm furniture placement">
        <strong>{pending.label}</strong><p>{pending.price ? formatMoney(pending.price.amountMinor, pending.price.currency) : "Price unknown"} · approximate display model, listed product dimensions</p>
        <div><button type="button" className="room-x__chip-btn" onClick={cancelProduct}>Cancel preview</button><button type="button" className="room-x__chip-btn room-x__chip-btn--ink" onClick={confirmProduct} disabled={blocked}>Confirm placement</button></div>
      </div> : null}
      {/* ---------- selection card ---------- */}
      {selected && ready && !pending ? (
        <div ref={cardRef} className="room-x__card" role="region" aria-label={`Selected: ${selected.label}`}>
          <div className="room-x__card-head">
            <div>
              <p className="room-x__card-tag">{selected.origin === "existing_owned" ? "Yours" : "New"}</p>
              <h2 className="room-x__card-title">{selected.label}</h2>
            </div>
            <button
              type="button"
              className="room-x__icon-btn"
              onClick={() => api()?.select(null)}
              aria-label="Clear selection"
            >
              {Icon.close}
            </button>
          </div>

          <p className="room-x__dims">
            {formatDimensions(selected.dimensions)}
            {selected.dimensionSource === "model" ? <span className="room-x__approx"> · approximate</span> : null}
          </p>
          {selected.priceMinor != null && selected.currency ? (
            <p className="room-x__price">{formatMoney(selected.priceMinor, selected.currency)}</p>
          ) : null}

          {selected.locked ? (
            <div>
              <p className="room-x__locked">{Icon.lock}<span>Locked in place. Unlock to rearrange this piece.</span></p>
              <button type="button" className="room-x__chip-btn" onClick={() => safely(() => api()?.setLocked(selected.id, false))}>Unlock for editing</button>
            </div>
          ) : moving ? (
            <div className="room-x__moving">
              <p>{coarse ? "Drag to place it, then confirm." : "Look where it should go, then click to set it down."}</p>
              <div className="room-x__moving-actions">
                <button type="button" className="room-x__chip-btn" onClick={cancelMove}>
                  Cancel <kbd>Esc</kbd>
                </button>
                <button type="button" className="room-x__chip-btn room-x__chip-btn--ink" onClick={() => safely(confirmMove)}>
                  Place here
                </button>
              </div>
            </div>
          ) : (
            <div className="room-x__actions">
              <button type="button" className="room-x__chip-btn" onClick={() => safely(() => api()?.setLocked(selected.id, true))}>Lock</button>
              <button type="button" className="room-x__chip-btn" onClick={() => safely(() => beginMove(selected))}>
                Move <kbd>G</kbd>
              </button>
              <button type="button" className="room-x__chip-btn" onClick={() => safely(() => api()?.rotate(selected.id, ROTATE_STEP))}>
                Rotate <kbd>R</kbd>
              </button>
              <button
                type="button"
                className="room-x__chip-btn"
                onClick={() => startSwap(selected)}
                aria-haspopup="dialog"
              >
                Swap
              </button>
              {selected.origin === "existing_owned" ? (
                <button type="button" className="room-x__chip-btn" onClick={() => safely(() => putAway(selected))}>
                  Put away <kbd>Del</kbd>
                </button>
              ) : (
                <button type="button" className="room-x__chip-btn" onClick={() => remove(selected)}>
                  Remove <kbd>Del</kbd>
                </button>
              )}
            </div>
          )}
        </div>
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
            <p className="room-x__panel-sub">
              {swapTarget
                ? `Replacing ${swapTarget.label}. The new piece takes its spot.`
                : "Search real retailers for pieces that fit this floor spot. Display models are approximate."}
            </p>
          </div>
          <button ref={catalogCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        <form className="room-x__search" onSubmit={(event) => { event.preventDefault(); runSearch(); }}>
          <label>What are you looking for?<input value={query} maxLength={300} placeholder="e.g. walnut chair, modern, easy to clean" onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="room-x__search-row"><label>Under $<input type="number" min="0.01" max="100000" step="0.01" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
          <label>Store<select value={merchant} onChange={(event) => setMerchant(event.target.value as "IKEA" | "Target")}><option>IKEA</option><option>Target</option></select></label></div>
          <label className="room-x__live"><input type="checkbox" checked={liveSearch && Boolean(shopping.session?.capabilities.liveSearch)} disabled={!shopping.session?.capabilities.liveSearch} onChange={(event) => setLiveSearch(event.target.checked)} /> Browse store live</label>
          {!shopping.session?.capabilities.liveSearch ? <p>Live browsing needs Browser Use configured on the server. Catalog search works now.</p> : null}
          <p>{swapTarget ? "Shopping at the selected piece’s spot." : floorSpot ? "Shopping at your selected floor spot." : "Shopping where you’re looking. Tap a clear floor spot in Dollhouse to change it."}</p>
          <button type="submit" className="room-x__chip-btn room-x__chip-btn--ink" disabled={blocked || !shopping.session}>Search furniture</button>
        </form>
        {shopping.job ? <p className="room-x__search-status" role="status">{shopping.job.output ? `${CATEGORY_LABEL[shopping.job.output.request.category]} · ${shopping.job.output.request.merchant ?? "IKEA"} · ` : ""}{shopping.job.stage}{shopping.job.output?.live === "failed" ? " · live search unavailable; catalog results remain usable." : ""}</p> : null}
        <div className="room-x__chips" role="group" aria-label="Filter by category">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className="room-x__chip"
              aria-pressed={category === c}
              onClick={() => { setCategory(c); }}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        {shopping.job && !results.length ? <p className="room-x__empty">No matches yet. Try another category, price cap or floor spot.</p> : null}
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
                <p className="room-x__product-name">{p.label}</p>
                <p className="room-x__product-meta">
                  <span>{p.merchant}</span>
                  {p.price ? <span className="room-x__product-price">{formatMoney(p.price.amountMinor, p.price.currency)}</span> : null}
                </p>
                <p className="room-x__product-dims">{p.dimensions ? formatDimensions(p.dimensions) : "Size not listed"}</p>
                <p className="room-x__product-dims">{result.source === "live" ? "Found by live search" : "Catalog observation"} · {result.fits ? result.withinBudget === false ? "Fits this spot, exceeds room budget" : "Fits this spot" : result.problems.join(" ") || "Does not fit"}</p>
                <a className="room-x__text-btn" href={/^https:\/\//i.test(p.sourceUrl) ? p.sourceUrl : undefined} target="_blank" rel="noreferrer">View at {p.merchant}</a>
                <button
                  type="button"
                  className="room-x__chip-btn room-x__chip-btn--ink room-x__product-add"
                  onClick={() => addProduct(p)}
                  disabled={!known || !p.price || !result.fits || result.withinBudget === false || blocked || !ready}
                  aria-label={`Preview ${p.label}`}
                >
                  {p.availability === "unavailable" ? "Unavailable" : "Preview"}
                </button>
              </li>
            );
          })}
        </ul>
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
            <p className="room-x__panel-sub">New pieces in this room. Things you already own stay free.</p>
          </div>
          <button ref={basketCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        {basket.length === 0 ? (
          <p className="room-x__empty">Nothing here yet. Pieces you add to the room show up in your basket.</p>
        ) : (
          <ul className="room-x__lines">
            {basket.map((i) => (
              <li key={i.id} className="room-x__line">
                <div className="room-x__line-main">
                  <p className="room-x__line-name">{i.label}</p>
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
          <button type="button" className="room-x__pill room-x__pill--ink room-x__checkout" disabled={!basket.length} onClick={exportBasket}>Export basket</button>
          {connectedProject && panel === "basket" ? <RoomCheckout projectId={connectedProject} planRevision={shopping.session!.plan.revision} onPlanRefresh={shopping.refresh} testPaymentsAvailable={shopping.session!.capabilities.testPayments} /> : <p className="room-x__note">Connect room shopping to review checkout.</p>}
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
            <p className="room-x__panel-sub">Pieces you put away. They are still yours, take one out to place it again.</p>
          </div>
          <button ref={inventoryCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        {inventory.length === 0 ? (
          <p className="room-x__empty">Nothing put away. Select a piece you own and choose Put away.</p>
        ) : (
          <ul className="room-x__lines">
            {inventory.map((i) => (
              <li key={i.id} className="room-x__line">
                <div className="room-x__line-main">
                  <p className="room-x__line-name">{i.label}</p>
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
