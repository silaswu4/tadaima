"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RoomPlan } from "@/backend/contracts";
import type {
  Alignment,
  Axis,
  ItemRenderState,
  OverlayFrame,
  PlacementPreview,
  Viewer,
  XRMode,
  XRStatus,
} from "@/spatial/room/viewer";
import { describeChange, diffPlans, dimensionSource } from "@/spatial/room/plan";

/** What the viewer hands back when someone drags or turns a piece. Not an accepted change. */
export type PlacementProposal = PlacementPreview;
export type { ItemRenderState };

export interface RoomViewerProps {
  plan: RoomPlan;
  /** The prior accepted revision. When given, changes since then are drawn on the floor. */
  previousPlan?: RoomPlan | null;
  showChanges?: boolean;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  /** Enables dragging and turning unlocked pieces. The viewer only previews; the parent decides. */
  onProposePlacement?: (proposal: PlacementProposal) => void;
  /** How each item is drawn (model, sized proxy, marker), for lists outside the canvas. */
  onItemStates?: (states: Record<string, ItemRenderState>) => void;
  className?: string;
}

const cm = (m: number) => Math.round(m * 100);
const STEP = 0.05;
const FINE = 0.01;
const TURN = Math.PI / 12; // 15 degrees

const ALIGN_TEXT: Record<Alignment, string> = {
  default: "Room is at a default spot",
  "pick-corner": "Lining up: mark the corner",
  "pick-wall": "Lining up: mark the wall",
  aligned: "Lined up for this session",
};

export function RoomViewer({
  plan,
  previousPlan = null,
  showChanges = true,
  selectedItemId,
  onSelectItem,
  onProposePlacement,
  onItemStates,
  className = "",
}: RoomViewerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const labels = useRef<Record<Axis, HTMLDivElement | null>>({ width: null, depth: null, height: null });
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [states, setStates] = useState<Record<string, ItemRenderState>>({});
  const [preview, setPreview] = useState<PlacementPreview | null>(null);
  const [proposed, setProposed] = useState(false);
  const [xr, setXr] = useState<XRStatus>({ presenting: false, mode: null, alignment: "default" });
  const [support, setSupport] = useState<Record<XRMode, boolean>>({ "immersive-vr": false, "immersive-ar": false });
  const [xrError, setXrError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // latest callbacks without re-creating the renderer
  const handlers = useRef({ onSelectItem, onItemStates });
  useEffect(() => {
    handlers.current = { onSelectItem, onItemStates };
  });
  // a selection made on the canvas should not also swing the camera
  const pickedOnCanvas = useRef<string | null | undefined>(undefined);
  const lastFrame = useRef<OverlayFrame | null>(null);
  const previewOpen = useRef(false);

  function placeOverlay(frame: OverlayFrame | null) {
    lastFrame.current = frame;
    const t = tag.current;
    if (t) {
      t.style.visibility = frame ? "visible" : "hidden";
      if (frame) {
        const width = canvas.current?.clientWidth ?? 0;
        const height = canvas.current?.clientHeight ?? 0;
        // narrow screens have no room beside the piece, so the card docks to the bottom edge
        const dock = width < 640;
        // otherwise the card is up to 290px wide; flip it left when it would run off the right edge
        const flip = !dock && frame.tag.x + 300 > width;
        t.style.transform = dock
          ? `translate(12px, ${height - 12 - (previewOpen.current ? 96 : 0)}px)`
          : `translate(${frame.tag.x}px, ${frame.tag.y}px)`;
        t.dataset.flip = flip ? "1" : "";
        t.dataset.dock = dock ? "1" : "";
      }
    }
    for (const axis of ["width", "depth", "height"] as const) {
      const el = labels.current[axis];
      if (!el) continue;
      const at = frame?.labels.find((l) => l.axis === axis);
      el.style.visibility = at ? "visible" : "hidden";
      if (at) el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
    }
  }

  useEffect(() => {
    let alive = true;
    let instance: Viewer | null = null;
    import("@/spatial/room/viewer")
      .then(({ createViewer }) => {
        if (!alive || !canvas.current) return;
        const lite = window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
        instance = createViewer(
          canvas.current,
          {
            select: (id) => {
              pickedOnCanvas.current = id;
              handlers.current.onSelectItem(id);
            },
            hover: () => {},
            preview: (p) => {
              previewOpen.current = Boolean(p);
              placeOverlay(lastFrame.current);
              setPreview(p);
              if (!p) setProposed(false);
            },
            items: (s) => {
              setStates(s);
              handlers.current.onItemStates?.(s);
            },
            xr: (s) => setXr(s),
            overlay: (frame) => placeOverlay(frame),
          },
          { lite },
        );
        setViewer(instance);
      })
      .catch((error: unknown) => alive && setFailed(error instanceof Error ? error.message : "The 3D view could not start."));

    const xrApi = typeof navigator !== "undefined" ? navigator.xr : undefined;
    if (xrApi) {
      for (const mode of ["immersive-vr", "immersive-ar"] as const) {
        xrApi.isSessionSupported(mode).then(
          (ok) => alive && setSupport((s) => ({ ...s, [mode]: ok })),
          () => {},
        );
      }
    }
    return () => {
      alive = false;
      instance?.dispose();
    };
  }, []);

  useEffect(() => {
    viewer?.setPlan(plan, previousPlan);
  }, [viewer, plan, previousPlan]);

  useEffect(() => {
    if (!viewer) return;
    viewer.setSelected(selectedItemId);
    if (selectedItemId && pickedOnCanvas.current !== selectedItemId) viewer.focus(selectedItemId);
    pickedOnCanvas.current = undefined;
  }, [viewer, selectedItemId]);

  const editable = Boolean(onProposePlacement);
  useEffect(() => {
    viewer?.setEditable(editable);
  }, [viewer, editable]);

  useEffect(() => {
    viewer?.setShowChanges(showChanges);
  }, [viewer, showChanges]);

  const selected = selectedItemId ? plan.items.find((i) => i.id === selectedItemId) : undefined;
  const source = selected ? dimensionSource(plan, selected) : null;
  const meshSize = selected ? states[selected.id]?.meshSize ?? null : null;
  const change =
    selected && previousPlan && showChanges ? diffPlans(previousPlan, plan).changes.find((c) => c.id === selected.id) : undefined;
  const size = source && source.kind !== "unknown" ? source.size : meshSize;
  const measured = source?.kind !== "unknown";
  const drawnAs = selected ? states[selected.id] : undefined;

  // a model drawn at its own size can disagree with the listed size; say by how much
  let mismatch: number | null = null;
  if (source && source.kind !== "unknown" && meshSize && drawnAs?.kind === "model") {
    const worst = Math.max(...meshSize.map((m, i) => Math.abs(m / source.size[i] - 1)));
    if (worst > 0.1) mismatch = Math.round(worst * 100);
  }

  function propose() {
    if (!preview || !onProposePlacement || preview.insideRoom === false) return;
    onProposePlacement(preview);
    setProposed(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLCanvasElement>) {
    if (!viewer) return;
    if (e.key === "Escape") {
      if (preview) viewer.clearPreview();
      else onSelectItem(null);
      e.preventDefault();
      return;
    }
    if (!editable || !selected || selected.locked) return;
    const step = e.shiftKey ? FINE : STEP;
    const moves: Record<string, [number, number, number]> = {
      ArrowLeft: [-step, 0, 0],
      ArrowRight: [step, 0, 0],
      ArrowUp: [0, -step, 0],
      ArrowDown: [0, step, 0],
      q: [0, 0, TURN],
      e: [0, 0, -TURN],
    };
    const move = moves[e.key];
    if (move) {
      viewer.nudge(...move);
      e.preventDefault();
    } else if (e.key === "Enter" && preview) {
      propose();
      e.preventDefault();
    }
  }

  async function enter(mode: XRMode) {
    setXrError(null);
    try {
      await viewer?.enterXR(mode);
    } catch (error) {
      setXrError(error instanceof Error ? error.message : "The headset session could not start.");
    }
  }

  const degrees = preview ? Math.round(((((preview.rotationY * 180) / Math.PI) % 360) + 360) % 360) : 0;

  return (
    <div className={`relative overflow-hidden bg-surface ${className}`}>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={`3D view of ${plan.geometry.rooms.map((r) => r.label).join(", ") || "the room"}, revision ${plan.revision}. Drag to orbit, scroll to zoom, click a piece to select it.${editable ? " With a piece selected, arrow keys move it and Q or E turn it." : ""} The object list beside the view has the same pieces.`}
        onKeyDown={onKeyDown}
        className={`block h-full w-full touch-none outline-none transition-opacity duration-700 focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset ${viewer ? "opacity-100" : "opacity-0"}`}
      />

      {failed && (
        <p className="absolute inset-x-4 top-4 border border-ink/20 bg-surface px-3 py-2 text-[13px] text-ink">
          {failed} The object list still works.
        </p>
      )}

      {/* selected piece: name, size and where that size came from */}
      <div ref={tag} className="pointer-events-none absolute top-0 left-0" style={{ visibility: "hidden" }}>
        {selected && (
          <div className="flex -translate-y-full items-end in-data-[flip=1]:-translate-x-full in-data-[flip=1]:flex-row-reverse">
            <div className="h-6 w-px bg-ink in-data-[dock=1]:hidden" />
            <div className="mb-6 min-w-[200px] in-data-[dock=1]:mb-0 max-w-[280px] bg-ink px-3 py-2 text-[12px] leading-[1.6] text-surface-soft">
              <div className="flex items-center justify-between gap-3">
                <span>{selected.label}</span>
                {selected.locked && <span className="text-surface-soft/60">Locked</span>}
              </div>
              {size ? (
                <div className="text-surface-soft/80">
                  {measured ? "" : "Model bounds "}
                  {cm(size[0])} w &middot; {cm(size[2])} d &middot; {cm(size[1])} h cm
                </div>
              ) : (
                <div className="text-surface-soft/80">Size unknown</div>
              )}
              <div className="text-surface-soft/50">
                {source?.kind === "product" && `Listing size, ${source.status}`}
                {source?.kind === "item" && `Item record, ${source.status}`}
                {source?.kind === "unknown" && "No product or measured size yet"}
              </div>
              {drawnAs?.kind === "proxy" && <div className="text-surface-soft/50">Drawn as a sized stand-in</div>}
              {drawnAs?.failed && <div className="text-surface-soft/50">Model failed to load</div>}
              {mismatch !== null && <div className="text-surface-soft/50">Model differs from this size by up to {mismatch}%</div>}
              {change && <div className="text-accent">{describeChange(change)} in revision {plan.revision}</div>}
            </div>
          </div>
        )}
      </div>

      {(["width", "depth", "height"] as const).map((axis) => (
        <div
          key={axis}
          ref={(el) => {
            labels.current[axis] = el;
          }}
          className="pointer-events-none absolute top-0 left-0 border border-ink/20 bg-surface px-1.5 text-[11px] leading-[1.5] text-ink"
          style={{ visibility: "hidden" }}
        >
          {size && `${cm(axis === "width" ? size[0] : axis === "depth" ? size[2] : size[1])}${measured ? "" : "?"}`}
        </div>
      ))}

      {/* local preview of a move; nothing changes in the plan until the parent accepts it */}
      {preview && (
        <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-x-4 gap-y-2 border border-ink/15 bg-surface px-3 py-2 text-[12px] text-ink md:inset-x-auto md:left-3">
          <span>
            Preview, not saved &middot; x {preview.position[0].toFixed(2)} m, z {preview.position[2].toFixed(2)} m, {degrees}&deg;
          </span>
          {preview.insideRoom === false && <span className="text-accent-deep">Goes past the room outline</span>}
          {preview.insideRoom === null && <span className="text-ink-soft">Size unknown, fit not checked</span>}
          <span className="flex gap-1">
            <button type="button" onClick={() => viewer?.nudge(0, 0, TURN)} className="border border-ink/20 px-2 py-1 hover:bg-ink/5">
              Turn left
            </button>
            <button type="button" onClick={() => viewer?.nudge(0, 0, -TURN)} className="border border-ink/20 px-2 py-1 hover:bg-ink/5">
              Turn right
            </button>
            <button
              type="button"
              onClick={propose}
              disabled={proposed || preview.insideRoom === false}
              className="bg-ink px-2 py-1 text-surface-soft disabled:opacity-40"
            >
              {proposed ? "Proposed" : "Propose move"}
            </button>
            <button type="button" onClick={() => viewer?.clearPreview()} className="border border-ink/20 px-2 py-1 hover:bg-ink/5">
              Discard
            </button>
          </span>
        </div>
      )}

      {/* headset entry, shown only where the browser says it can */}
      {(support["immersive-vr"] || support["immersive-ar"] || xr.presenting) && (
        <div className="absolute top-3 right-3 flex flex-col items-end gap-2 text-[12px]">
          {xr.presenting ? (
            <>
              <button type="button" onClick={() => viewer?.exitXR()} className="bg-ink px-3 py-2 text-surface-soft">
                Leave headset view
              </button>
              <button type="button" onClick={() => viewer?.resetAlignment()} className="border border-ink/20 bg-surface px-3 py-2 text-ink">
                Reset alignment
              </button>
            </>
          ) : (
            <span className="flex gap-2">
              {support["immersive-vr"] && (
                <button type="button" onClick={() => enter("immersive-vr")} disabled={!viewer} className="bg-ink px-3 py-2 text-surface-soft disabled:opacity-40">
                  View in headset
                </button>
              )}
              {support["immersive-ar"] && (
                <button type="button" onClick={() => enter("immersive-ar")} disabled={!viewer} className="border border-ink/20 bg-surface px-3 py-2 text-ink disabled:opacity-40">
                  Passthrough
                </button>
              )}
            </span>
          )}
          {(xr.presenting || xr.alignment === "aligned") && (
            <span className="bg-surface/90 px-2 py-1 text-ink-soft">{ALIGN_TEXT[xr.alignment]}</span>
          )}
          {xrError && <span className="max-w-[260px] bg-surface px-2 py-1 text-right text-accent-deep">{xrError}</span>}
        </div>
      )}
    </div>
  );
}
