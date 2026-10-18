"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FloorSpot, FurnitureCategory, ProductCandidate, RoomPlan, Vector3Meters } from "../../backend/contracts";
import catalogJson from "../../backend/fixtures/real-catalog.json";
import type { WalkCallbacks, WalkEnvironment, WalkItem, WalkMode, WalkOptions, WalkScene } from "../room/walk-api";
import mark from "../assets/tadaima-mark.png";
import { WipeLink, useWipeHold } from "./PageWipe";
import "./RoomExperience.css";

export type ExperienceRoom = { id: string; label: string; plan: RoomPlan; environment?: WalkEnvironment; reconstruction?: WalkOptions["reconstruction"]; sourceDescription?: string };
type Props = { room: ExperienceRoom; backHref?: string; onPlanChange?: (plan: RoomPlan) => Promise<void> };
type Panel = "catalog" | "basket" | "inventory" | null;
type Anchor = { x: number; y: number } | null;

// The JSON import widens tuples to number[], so narrow it once here.
const CATALOG = (catalogJson as unknown as { products: ProductCandidate[] }).products;

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
const ENGINE_KEYS = new Set(["g", "r", "w", "a", "s", "d", "delete", "backspace", "z"]);
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
  const [category, setCategory] = useState<FurnitureCategory | "all">("all");
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const [notice, setNotice] = useState<string | null>(null);

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
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePanel();
        return;
      }
      if (ENGINE_KEYS.has(e.key.toLowerCase())) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [panel, closePanel]);

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
          saveRef.current?.(snapshot).catch((cause) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : "Could not save this edit. Keep this room open and try again."); });
        }
      },
      onMoveChange(value) { if (!cancelled) setMoving(value); },
      onProductPreviewChange(preview) { if (!cancelled && !preview) setPending(null); },
      onExplodeChange(value) { if (!cancelled) { setExploded(value); setPending(null); } },
      onShoppingFloor(spot) { if (!cancelled) { setFloorSpot(spot); setNotice("Shopping spot selected. Choose a piece to preview here."); } },
      onPreviewOffer(id) { const product = CATALOG.find((p) => p.id === id); if (product) previewRef.current(product); },
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
    setCategory(CATALOG.some((p) => p.category === item.category) ? item.category : "all");
    openPanel("catalog");
    setSwapTarget(item);
  };

  const addProduct = (product: ProductCandidate) => {
    const w = api();
    if (!w || !product.dimensions) return;
    try {
      w.cancelProductPreview();
      setPending(null);
      w.previewProduct(product, { swapId: swapTarget?.id, at: floorSpot ? [floorSpot.position[0], floorSpot.position[2]] : undefined });
      setPending(product);
      setNotice(`Previewing ${product.label}. Confirm placement to add it to this room.`);
      setPanel(null);
      openerRef.current = null;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "That piece could not be placed.");
    }
  };
  useLayoutEffect(() => { previewRef.current = addProduct; });

  const confirmProduct = () => {
    try {
      const id = api()?.confirmProductPreview();
      if (!id) return;
      api()?.select(id);
      setPending(null);
      setSwapTarget(null);
      setNotice("Added to your room and preview basket. Nothing purchased.");
    } catch (err) { setNotice(err instanceof Error ? err.message : "Placement could not be confirmed."); }
  };
  useLayoutEffect(() => { confirmRef.current = confirmProduct; });
  const cancelProduct = () => { api()?.cancelProductPreview(); setPending(null); setSwapTarget(null); };
  const safely = (action: () => void) => {
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
      exportedAt: new Date().toISOString(), items: basket.map((item) => ({ ...item, sourceUrl: CATALOG.find((p) => p.id === item.productId)?.sourceUrl ?? null })) }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `tadaima-basket-${room.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };


  const categories = useMemo(() => {
    const seen = new Set(CATALOG.map((p) => p.category));
    return (Object.keys(CATEGORY_LABEL) as FurnitureCategory[]).filter((c) => seen.has(c));
  }, []);
  const products = useMemo(() => category === "all" ? CATALOG : CATALOG.filter((p) => p.category === category), [category]);

  useEffect(() => {
    if (status !== "ready") return;
    walkRef.current?.setXRShopping({
      offers: products.filter((p) => p.dimensions && p.price && p.availability !== "unavailable").slice(0, 3).map((p) => ({ id: p.id, label: p.label, detail: p.price ? `${formatMoney(p.price.amountMinor, p.price.currency)} · ${p.merchant} · saved observation` : p.merchant })),
      selectedItemLabel: selected?.label, pendingOfferId: pending?.id, canConfirm: Boolean(pending),
      status: notice ?? "Trigger: select furniture or floor. Left stick: teleport. Right stick: snap turn. Preview basket only.",
    });
  }, [status, products, selected, pending, notice]);

  const ready = status === "ready";
  const showHint = ready && mode === "walk" && !hintSeen && !panel;

  return (
    <div
      className="room-x"
      data-ready={ready || undefined}
      data-mode={mode}
      data-locked={locked || undefined}
      data-touch={coarse || undefined}
    >
      <canvas
        ref={canvasRef}
        className="room-x__canvas"
        role="img"
        aria-label={`${room.label}, walkable view`}
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
      />

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
              <button type="button" aria-pressed={mode === "walk"} onClick={() => setMode("walk")} disabled={!ready}>
                Walk
              </button>
              <button type="button" aria-pressed={mode === "orbit"} onClick={() => setMode("orbit")} disabled={!ready}>
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
              disabled={!ready}
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
            disabled={!ready}
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
            disabled={!canUndo}
            aria-label="Undo last change"
          >
            {Icon.undo}
            <span className="room-x__tools-text">Undo</span>
          </button>
          <button
            type="button"
            className="room-x__pill room-x__pill--ink"
            onClick={openCatalog}
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
        <div><button type="button" className="room-x__chip-btn" onClick={cancelProduct}>Cancel preview</button><button type="button" className="room-x__chip-btn room-x__chip-btn--ink" onClick={confirmProduct}>Confirm placement</button></div>
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
                : "Listed dimensions, approximate display models. Prices and stock are saved observations."}
            </p>
          </div>
          <button ref={catalogCloseRef} type="button" className="room-x__icon-btn" onClick={closePanel} aria-label="Close">
            {Icon.close}
          </button>
        </div>

        <div className="room-x__chips" role="group" aria-label="Filter by category">
          {(["all", ...categories] as const).map((c) => (
            <button
              key={c}
              type="button"
              className="room-x__chip"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c === "all" ? "All" : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <ul className="room-x__products">
          {products.map((p) => {
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
                <button
                  type="button"
                  className="room-x__chip-btn room-x__chip-btn--ink room-x__product-add"
                  onClick={() => addProduct(p)}
                  disabled={!known || !p.price || p.availability === "unavailable" || !ready}
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
          <p className="room-x__note">Preview only. Prices and stock need rechecking; tax and delivery are unknown. No payment or order is placed.</p>
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
