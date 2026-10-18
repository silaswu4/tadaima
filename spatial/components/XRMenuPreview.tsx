"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import type { ProductCandidate } from "../../backend/contracts";
import observedCatalog from "../../backend/fixtures/real-catalog.json";
import { createXRMenu } from "../room/workspace-xr-menu";
import type { WorkspaceXRShopping } from "../room/workspace-xr";
import { roomProductMoney } from "./RoomProductCard";
import "./XRMenuPreview.css";

const available = (observedCatalog.products as ProductCandidate[]).filter((product) => product.dimensions && product.price?.currency === "USD" && product.availability === "available");
const featured = [available.find((product) => product.category === "chair"), available.find((product) => product.category === "rug"), available.find((product) => product.category === "lamp")].filter((product): product is ProductCandidate => Boolean(product));
const products = [...featured, ...available.filter((product) => !featured.some((entry) => entry.id === product.id))].slice(0, 8);
const offers = products.map((product) => ({ id: product.id, label: product.label, product, source: "catalog" as const,
  detail: `${roomProductMoney(product.price?.amountMinor, product.price?.currency)} · ${product.merchant}`, fits: true, withinBudget: true, problems: [] }));
const categories = ["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor"];
type Scenario = "start" | "results" | "placement" | "locked";
type PreviewState = { scenario: Scenario; voice: { connected: boolean; listening: boolean }; pendingId: string | null; selectedId: string; stored: ReadonlySet<string>; removed: ReadonlySet<string> };
function fixture({ scenario, voice, pendingId, selectedId, stored, removed }: PreviewState): WorkspaceXRShopping {
  const inventory = products.slice(0, 5).map((product) => ({ id: `example-${product.id}`, label: product.label, category: product.category, dimensions: product.dimensions,
    stored: stored.has(`example-${product.id}`), locked: scenario === "locked" && `example-${product.id}` === selectedId, selected: `example-${product.id}` === selectedId }));
  const selected = inventory.find((item) => item.id === selectedId);
  const basket = products.slice(0, 2).filter((product) => !removed.has(`basket-${product.id}`)).map((product) => ({ id: `basket-${product.id}`, label: product.label,
    dimensions: product.dimensions, priceMinor: product.price?.amountMinor, currency: product.price?.currency, imageUrl: product.imageUrl }));
  const total = roomProductMoney(basket.reduce((sum, item) => sum + (item.priceMinor ?? 0), 0), "USD");
  return { offers: scenario === "start" ? [] : offers, inventory, basket, basketTotal: total, roomLabel: "UI preview",
    actions: [
      ...categories.map((category) => ({ id: `search-${category}`, label: `Find ${category}` })),
      { id: "rotate-selected", label: "Rotate", disabled: selected?.locked || selected?.stored || !selected },
      { id: "store-selected", label: "Put away", disabled: selected?.locked || selected?.stored || !selected },
      { id: "cancel-preview", label: "Cancel", disabled: scenario !== "placement" },
      ...inventory.flatMap((item) => [{ id: `select-item:${item.id}`, label: "Select" }, { id: `take-out:${item.id}`, label: "Bring back", disabled: !item.stored || item.locked }]),
      ...basket.map((item) => ({ id: `remove-item:${item.id}`, label: "Remove" })),
      { id: "voice-toggle", label: "Demo talk" }, { id: "voice-stop", label: "End demo conversation", disabled: !voice.connected },
    ],
    agent: { available: true, ...voice, status: voice.listening ? "Demo listening" : voice.connected ? "Demo connected" : "Demo voice",
      caption: voice.connected ? "Example response only: I would preview a piece here and ask for your approval." : undefined,
      transcript: voice.connected ? "Example request: find a warm wood chair under $300." : undefined },
    basketLabel: `Basket ${basket.length} · ${total}`, selectedItemLabel: selected?.label, selectedItemLocked: selected?.locked,
    status: "Saved catalog examples · synthetic room/fit. No live search is running.",
    pendingOfferId: scenario === "placement" ? pendingId ?? products[0]?.id : null, canConfirm: scenario === "placement" };
}

/** The actual immersive DOM rasterizer, with saved product observations and synthetic room/fit data. */
export function XRMenuPreview() {
  const holder = useRef<HTMLDivElement>(null), menu = useRef<ReturnType<typeof createXRMenu> | null>(null);
  const [scenario, setScenario] = useState<Scenario>("results"), [message, setMessage] = useState("Saved catalog examples · synthetic room/fit. No API mutations or microphone."), [movement, setMovement] = useState<"walk" | "teleport">("walk");
  const [voice, setVoice] = useState({ connected: false, listening: false }), [pendingId, setPendingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(`example-${products[0]?.id}`);
  const [stored, setStored] = useState<ReadonlySet<string>>(() => new Set([`example-${products[4]?.id}`]));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const next = createXRMenu({ onPreviewOffer: (id) => { setPendingId(id); setScenario("placement"); },
      onConfirmOffer: () => { setMessage("Placement confirmation clicked (synthetic preview only)."); setPendingId(null); setScenario("results"); },
      onAction: (id) => {
        if (id === "voice-toggle") setVoice((value) => ({ connected: true, listening: !value.listening }));
        else if (id === "voice-stop") setVoice({ connected: false, listening: false });
        else if (id === "cancel-preview") { setPendingId(null); setScenario("results"); }
        else if (id.startsWith("search-")) setScenario("results");
        else if (id.startsWith("select-item:")) setSelectedId(id.slice("select-item:".length));
        else if (id.startsWith("take-out:")) setStored((value) => { const updated = new Set(value); updated.delete(id.slice("take-out:".length)); return updated; });
        else if (id.startsWith("remove-item:")) setRemoved((value) => new Set([...value, id.slice("remove-item:".length)]));
        setMessage(`${id} clicked (synthetic preview only).`);
      },
      onLocomotionToggle: () => setMovement((value) => value === "walk" ? "teleport" : "walk"), onExit: () => setMessage("Exit VR clicked (preview only)."), onClose: () => setMessage("Close menu clicked (preview only).") });
    menu.current = next;
    const canvas = next.mesh.material.map!.image as HTMLCanvasElement;
    canvas.setAttribute("aria-label", "Interactive headset menu preview"); canvas.setAttribute("role", "img");
    const uv = (event: PointerEvent | MouseEvent) => { const rect = canvas.getBoundingClientRect(); return new THREE.Vector2((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height); };
    const hover = (event: PointerEvent) => next.setHovered([uv(event)]), leave = () => next.setHovered([]), click = (event: MouseEvent) => next.activate(uv(event));
    const wheel = (event: WheelEvent) => { if (event.ctrlKey) return; event.preventDefault(); next.scroll(event.deltaY * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 500 : 1)); };
    canvas.addEventListener("pointermove", hover); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("click", click); canvas.addEventListener("wheel", wheel, { passive: false });
    holder.current?.replaceChildren(canvas);
    return () => { canvas.removeEventListener("pointermove", hover); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("click", click); canvas.removeEventListener("wheel", wheel); next.dispose(); canvas.remove(); menu.current = null; };
  }, []);
  useEffect(() => { menu.current?.setState(fixture({ scenario, voice, pendingId, selectedId, stored, removed }), movement); }, [scenario, movement, voice, pendingId, selectedId, stored, removed]);
  return <main className="xr-preview"><header><div><p>tadaima / spatial interface</p><h1>Headset menu preview</h1></div><Link href="/rooms">Back to rooms</Link></header>
    <p className="xr-preview__note">The same website DOM rendered inside VR. Saved catalog examples · synthetic room/fit. Voice controls simulate UI state only; no microphone or agent session is started. Scroll over the panel to browse.</p>
    <div className="xr-preview__tools" aria-label="Preview scenarios">{(["start", "results", "placement", "locked"] as Scenario[]).map((value) => <button key={value} aria-pressed={scenario === value} onClick={() => { setScenario(value); if (value !== "placement") setPendingId(null); }}>{value}</button>)}</div>
    <div ref={holder} className="xr-preview__canvas" /><p role="status" className="xr-preview__note">{message}</p></main>;
}
