"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import { createXRMenu } from "../room/workspace-xr-menu";
import type { WorkspaceXRShopping } from "../room/workspace-xr";
import "./XRMenuPreview.css";

const actions = ["search-chair", "search-rug", "search-lamp", "rotate-selected", "store-selected", "cancel-preview"].map((id) => ({ id, label: id }));
const offers = [
  { id: "chair", label: "Fabric lounge chair", detail: "$99.99 · Example catalog" },
  { id: "rug", label: "Woven living room rug", detail: "$129.00 · Example catalog" },
  { id: "lamp", label: "Reading floor lamp", detail: "$59.99 · Example catalog" },
];
type Scenario = "start" | "results" | "placement" | "locked";
function fixture(scenario: Scenario): WorkspaceXRShopping {
  return { offers: scenario === "start" ? [] : offers, actions, basketLabel: "Basket 0 · $0.00",
    selectedItemLabel: "Your lounge chair", selectedItemLocked: scenario === "locked",
    status: scenario === "start" ? "Point at a floor spot, then choose a category." : "3 pieces fit this spot. Choose one to try in the room.",
    pendingOfferId: scenario === "placement" ? "chair" : null, canConfirm: scenario === "placement" };
}

/** Diagnostic view of the actual headset canvas, with synthetic data and no API mutations. */
export function XRMenuPreview() {
  const holder = useRef<HTMLDivElement>(null), menu = useRef<ReturnType<typeof createXRMenu> | null>(null);
  const [scenario, setScenario] = useState<Scenario>("results"), [message, setMessage] = useState("Synthetic preview. Buttons here do not edit a room."), [movement, setMovement] = useState<"walk" | "teleport">("walk");
  useEffect(() => {
    const next = createXRMenu({ onPreviewOffer: () => setScenario("placement"), onConfirmOffer: () => { setMessage("Placement confirmation clicked (preview only)."); setScenario("results"); },
      onAction: (id) => { if (id === "cancel-preview") setScenario("results"); else if (id.startsWith("search-")) setScenario("results"); else setMessage(`${id} clicked (preview only).`); },
      onLocomotionToggle: () => setMovement((value) => value === "walk" ? "teleport" : "walk"), onExit: () => setMessage("Exit VR clicked (preview only)."), onClose: () => setMessage("Close menu clicked (preview only).") });
    menu.current = next;
    const canvas = next.mesh.material.map!.image as HTMLCanvasElement;
    canvas.setAttribute("aria-label", "Interactive headset menu preview"); canvas.setAttribute("role", "img");
    const uv = (event: PointerEvent | MouseEvent) => { const rect = canvas.getBoundingClientRect(); return new THREE.Vector2((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height); };
    const hover = (event: PointerEvent) => next.setHovered([uv(event)]), leave = () => next.setHovered([]), click = (event: MouseEvent) => next.activate(uv(event));
    canvas.addEventListener("pointermove", hover); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("click", click);
    holder.current?.replaceChildren(canvas);
    return () => { canvas.removeEventListener("pointermove", hover); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("click", click); next.dispose(); canvas.remove(); menu.current = null; };
  }, []);
  useEffect(() => { menu.current?.setState(fixture(scenario), movement); }, [scenario, movement]);
  return <main className="xr-preview"><header><div><p>tadaima / spatial interface</p><h1>Headset menu preview</h1></div><Link href="/rooms">Back to rooms</Link></header><p className="xr-preview__note">This is the same canvas drawn inside VR. Example products only.</p><div className="xr-preview__tools" aria-label="Preview scenarios">{(["start", "results", "placement", "locked"] as Scenario[]).map((value) => <button key={value} aria-pressed={scenario === value} onClick={() => setScenario(value)}>{value}</button>)}</div><div ref={holder} className="xr-preview__canvas" /><p role="status" className="xr-preview__note">{message}</p></main>;
}
