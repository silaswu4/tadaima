"use client";

import { useEffect, useRef, useState } from "react";
import type { FloorSpot, PlacedItem, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { dragCheck, turned, type DragCheck } from "@/backend/shopping/drag";

type Pt = readonly [number, number];

/** Footprint corners on the floor. three.js rotation about +Y: x' = x cos + z sin, z' = -x sin + z cos. */
export function footprint(item: Pick<PlacedItem, "dimensions" | "position" | "rotationY">): Pt[] {
  const [w, , d] = item.dimensions ?? [0.3, 0, 0.3];
  const [cx, , cz] = item.position;
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  return (
    [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ] as const
  ).map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c] as const);
}

function inside([x, z]: Pt, poly: readonly Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

const pts = (p: Pt[]) => p.map(([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`).join(" ");

/** Has this item moved, resized or changed product between two plans? */
function changed(a: PlacedItem, b: PlacedItem) {
  return (
    a.productId !== b.productId ||
    a.rotationY !== b.rotationY ||
    a.locked !== b.locked ||
    a.label !== b.label ||
    JSON.stringify(a.position) !== JSON.stringify(b.position) ||
    JSON.stringify(a.dimensions) !== JSON.stringify(b.dimensions)
  );
}

interface Drag {
  id: string;
  pointerId: number;
  /** Grab point minus item center, so the piece doesn't jump to the cursor. */
  offset: [number, number];
  startClient: [number, number];
  at: [number, number];
  rotationY: number;
  moved: boolean;
  check: DragCheck | null;
}

const DRAG_PX = 4;

export function RoomMap({
  plan,
  basePlan,
  failing,
  selectedId,
  onSelect,
  spot,
  onSpot,
  ghost,
  onDrop,
}: {
  plan: RoomPlan;
  /** When showing a proposal: the current plan, so changed/removed items can be marked. */
  basePlan?: RoomPlan | null;
  failing: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Picked floor point, drawn as a marker. */
  spot?: FloorSpot | null;
  /** Clicking empty floor picks a spot. */
  onSpot?: (spot: FloorSpot) => void;
  /** A product previewed where it would go, not yet in the plan. */
  ghost?: { label: string; dimensions: Vector3Meters; position: Vector3Meters; rotationY: number } | null;
  /** Dragging is on when set: called on release with the pose `dragCheck` found. */
  onDrop?: (item: PlacedItem, pose: DragCheck["pose"]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // the click that ends a drag shouldn't also select or pick a spot
  const swallowClick = useRef(false);

  const toWorld = (clientX: number, clientY: number) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y] as [number, number];
  };

  /** Run the same fit rules the server will, for the piece held at `at`. */
  const check = (id: string, at: [number, number], offset: [number, number], rotationY: number): DragCheck => {
    const item = plan.items.find((i) => i.id === id)!;
    const position: Vector3Meters = [at[0] - offset[0], 0, at[1] - offset[1]];
    if (item.locked) return { fits: false, pose: { position, rotationY }, snapped: false, droppable: false, problems: ["Locked. Unlock it to move it."] };
    try {
      return dragCheck(plan, id, position, rotationY);
    } catch (e) {
      return { fits: false, pose: { position, rotationY }, snapped: false, droppable: false, problems: [(e as Error).message] };
    }
  };

  // R turns the held piece a quarter
  const dragging = drag?.moved ? drag.id : null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      e.preventDefault();
      setDrag((d) => {
        if (!d) return d;
        const rotationY = turned(d.rotationY, e.shiftKey ? -1 : 1);
        return { ...d, rotationY, check: check(d.id, d.at, d.offset, rotationY) };
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // check reads the latest plan through the closure at keypress time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const g = plan.geometry;
  const all: Pt[] = [...g.rooms.flatMap((r) => r.floorPolygon), ...g.walls.flatMap((w) => [w.start, w.end])];
  const xs = all.map((p) => p[0]);
  const zs = all.map((p) => p[1]);
  const pad = 0.45;
  const minX = Math.min(...xs) - pad;
  const minZ = Math.min(...zs) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const h = Math.max(...zs) - Math.min(...zs) + pad * 2;

  const baseById = new Map(basePlan?.items.map((i) => [i.id, i]) ?? []);
  const removed = basePlan ? basePlan.items.filter((i) => !plan.items.some((p) => p.id === i.id)) : [];

  // draw rugs first so furniture sits on top; stored pieces are in inventory, not on the floor
  const items = plan.items.filter((i) => !i.stored).sort((a, b) => Number(b.category === "rug") - Number(a.category === "rug"));
  const held = drag?.moved ? plan.items.find((i) => i.id === drag.id) : undefined;

  return (
    <svg
      ref={svgRef}
      viewBox={`${minX} ${minZ} ${w} ${h}`}
      className="block h-auto w-full touch-none select-none"
      onPointerMove={(e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const moved = drag.moved || Math.hypot(e.clientX - drag.startClient[0], e.clientY - drag.startClient[1]) > DRAG_PX;
        if (!moved) return;
        const at = toWorld(e.clientX, e.clientY);
        if (!at) return;
        setDrag({ ...drag, moved, at, check: check(drag.id, at, drag.offset, drag.rotationY) });
      }}
      onPointerUp={(e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const d = drag;
        setDrag(null);
        // pointer capture retargets the click to the svg, so a plain click selects here
        swallowClick.current = true;
        if (!d.moved) return onSelect(d.id);
        const item = plan.items.find((i) => i.id === d.id);
        if (item && d.check?.droppable) onDrop?.(item, d.check.pose);
      }}
      onPointerCancel={() => setDrag(null)}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
      }}
      onClick={(e) => {
        const ctm = e.currentTarget.getScreenCTM();
        // screen to world: the viewBox is in meters, x right, z down the page
        const p = ctm && new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        const onFloor = p && g.rooms.some((r) => inside([p.x, p.y], r.floorPolygon));
        // floor clicks pick a spot and keep the selection (so "move selected here" works); outside the room deselects
        if (!onSpot || !p || !onFloor) return onSelect(null);
        onSpot({ position: [Math.round(p.x * 100) / 100, 0, Math.round(p.y * 100) / 100] });
      }}
      role="img"
      aria-label="Top-down room map"
    >
      <defs>
        <pattern id="grid" width="0.5" height="0.5" patternUnits="userSpaceOnUse">
          <path d="M 0.5 0 L 0 0 0 0.5" fill="none" stroke="#e7e7e4" strokeWidth="0.008" />
        </pattern>
        <marker id="front" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" />
        </marker>
        <pattern id="hatch" width="0.08" height="0.08" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.08" stroke="#9ca3af" strokeWidth="0.012" />
        </pattern>
      </defs>

      {g.rooms.map((r) => (
        <polygon key={r.id} points={pts(r.floorPolygon)} fill="url(#grid)" stroke="none" />
      ))}

      {g.walls.map((wall) => (
        <line
          key={wall.id}
          x1={wall.start[0]}
          y1={wall.start[1]}
          x2={wall.end[0]}
          y2={wall.end[1]}
          stroke="#27272a"
          strokeWidth={wall.thickness}
          strokeLinecap="square"
        />
      ))}

      {g.openings.map((o) => {
        const wall = g.walls.find((x) => x.id === o.wallId);
        if (!wall) return null;
        const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
        const ux = (wall.end[0] - wall.start[0]) / len;
        const uz = (wall.end[1] - wall.start[1]) / len;
        // offset is read as distance from the wall start to the near edge of the opening
        const a = [wall.start[0] + ux * o.offset, wall.start[1] + uz * o.offset];
        const b = [a[0] + ux * o.width, a[1] + uz * o.width];
        const door = o.kind === "door";
        return (
          <g key={o.id}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth={wall.thickness + 0.02} />
            <line
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={door ? "#b45309" : "#0284c7"}
              strokeWidth={door ? 0.05 : 0.04}
              strokeDasharray={door ? undefined : "0.08 0.05"}
            />
            <text
              x={(a[0] + b[0]) / 2}
              y={(a[1] + b[1]) / 2}
              dy={uz === 0 ? (a[1] < minZ + h / 2 ? -0.13 : 0.22) : 0}
              dx={ux === 0 ? (a[0] < minX + w / 2 ? -0.12 : 0.12) : 0}
              fontSize="0.11"
              fill={door ? "#b45309" : "#0284c7"}
              textAnchor={ux === 0 ? (a[0] < minX + w / 2 ? "end" : "start") : "middle"}
              dominantBaseline="middle"
            >
              {o.kind}
            </text>
          </g>
        );
      })}

      {removed.map((i) => (
        <g key={`gone-${i.id}`} pointerEvents="none">
          <polygon points={pts(footprint(i))} fill="none" stroke="#dc2626" strokeWidth="0.02" strokeDasharray="0.06 0.04" />
          <text x={i.position[0]} y={i.position[2]} fontSize="0.1" fill="#dc2626" textAnchor="middle" dominantBaseline="middle">
            removed: {i.label}
          </text>
        </g>
      ))}

      {items.map((i) => {
        const owned = i.origin === "existing_owned";
        const bad = failing.has(i.id);
        const sel = i.id === selectedId;
        const base = baseById.get(i.id);
        const isNew = basePlan != null && !base;
        const isChanged = basePlan != null && base != null && changed(base, i);
        const corners = footprint(i);
        const rug = i.category === "rug";
        return (
          <g
            key={i.id}
            className={onDrop ? "cursor-grab" : "cursor-pointer"}
            opacity={held?.id === i.id ? 0.3 : 1}
            onPointerDown={(e) => {
              if (!onDrop || e.button !== 0) return;
              const at = toWorld(e.clientX, e.clientY);
              if (!at) return;
              svgRef.current?.setPointerCapture(e.pointerId);
              setDrag({
                id: i.id,
                pointerId: e.pointerId,
                offset: [at[0] - i.position[0], at[1] - i.position[2]],
                startClient: [e.clientX, e.clientY],
                at,
                rotationY: i.rotationY,
                moved: false,
                check: null,
              });
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(i.id);
            }}
          >
            {isChanged && base && (
              <polygon points={pts(footprint(base))} fill="none" stroke="#7c3aed" strokeWidth="0.015" strokeDasharray="0.05 0.04" pointerEvents="none" />
            )}
            <polygon
              points={pts(corners)}
              fill={owned ? "#d4d4d8" : rug ? "rgba(16,185,129,0.10)" : "rgba(16,185,129,0.22)"}
              stroke={bad ? "#dc2626" : sel ? "#2563eb" : isNew || isChanged ? "#7c3aed" : owned ? "#52525b" : "#059669"}
              strokeWidth={bad || sel ? 0.04 : 0.018}
              strokeDasharray={owned ? undefined : rug ? "0.05 0.03" : undefined}
            />
            {i.locked && <polygon points={pts(corners)} fill="url(#hatch)" pointerEvents="none" />}
            {(() => {
              const sub = isNew ? "new" : isChanged ? "changed" : i.locked ? "locked" : null;
              const { lines, fs } = fitLabel(short(i.label), corners);
              const zs = corners.map((c) => c[1]);
              const lh = fs * 1.15;
              const block = lines.length * lh + (sub ? fs * 0.95 : 0);
              // rugs sit under tables, so label them along their top edge
              const top = rug ? Math.min(...zs) + 0.06 : i.position[2] - block / 2;
              return (
                <g pointerEvents="none">
                  {lines.map((line, k) => (
                    <text
                      key={k}
                      x={i.position[0]}
                      y={top + lh * (k + 0.5)}
                      fontSize={fs}
                      fill="#18181b"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontWeight={sel ? 600 : 500}
                    >
                      {line}
                    </text>
                  ))}
                  {sub && (
                    <text
                      x={i.position[0]}
                      y={top + lines.length * lh + fs * 0.45}
                      fontSize={fs * 0.75}
                      fill={sub === "locked" ? "#52525b" : "#7c3aed"}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {sub}
                    </text>
                  )}
                </g>
              );
            })()}
          </g>
        );
      })}
      {ghost && <Ghost ghost={ghost} />}
      {held && drag?.check && (
        <Held item={held} check={drag.check} hand={[drag.at[0] - drag.offset[0], 0, drag.at[1] - drag.offset[1]]} />
      )}

      {spot && (
        <g pointerEvents="none" transform={`translate(${spot.position[0]} ${spot.position[2]})`}>
          <circle r="0.09" fill="rgba(37,99,235,0.12)" stroke="#2563eb" strokeWidth="0.015" />
          <line x1="-0.15" x2="0.15" stroke="#2563eb" strokeWidth="0.012" />
          <line y1="-0.15" y2="0.15" stroke="#2563eb" strokeWidth="0.012" />
        </g>
      )}
    </svg>
  );
}

function Ghost({ ghost }: { ghost: { label: string; dimensions: Vector3Meters; position: Vector3Meters; rotationY: number } }) {
  const corners = footprint(ghost);
  const [cx, , cz] = ghost.position;
  const d = ghost.dimensions[2];
  // front is local +Z, which rotationY sends to (sin r, cos r)
  const fx = Math.sin(ghost.rotationY);
  const fz = Math.cos(ghost.rotationY);
  const tip = [cx + fx * (d / 2 + 0.14), cz + fz * (d / 2 + 0.14)];
  const back = [cx + fx * (d / 2 + 0.02), cz + fz * (d / 2 + 0.02)];
  return (
    <g pointerEvents="none">
      <polygon points={pts(corners)} fill="rgba(37,99,235,0.10)" stroke="#2563eb" strokeWidth="0.025" strokeDasharray="0.07 0.045" />
      <line x1={back[0]} y1={back[1]} x2={tip[0]} y2={tip[1]} stroke="#2563eb" strokeWidth="0.025" markerEnd="url(#front)" />
      <text x={cx} y={cz} fontSize="0.09" fill="#1d4ed8" textAnchor="middle" dominantBaseline="middle" fontWeight={600}>
        {short(ghost.label)}
      </text>
    </g>
  );
}

/** The piece in the shopper's hand: green fits, amber snaps to the nearest fit, red can't drop. */
function Held({ item, check, hand }: { item: PlacedItem; check: DragCheck; hand: Vector3Meters }) {
  const color = check.fits ? "#059669" : check.droppable ? "#d97706" : "#dc2626";
  const fill = check.fits ? "rgba(16,185,129,0.22)" : check.droppable ? "rgba(245,158,11,0.20)" : "rgba(239,68,68,0.18)";
  const shown = { ...item, ...check.pose };
  const corners = footprint(shown);
  const [cx, , cz] = check.pose.position;
  const d = item.dimensions?.[2] ?? 0.3;
  const fx = Math.sin(check.pose.rotationY);
  const fz = Math.cos(check.pose.rotationY);
  const zs = corners.map((c) => c[1]);
  const note = check.fits ? null : check.droppable ? "snaps here" : (check.problems[0] ?? "doesn't fit");
  return (
    <g pointerEvents="none">
      {/* where the hand actually is, when the drop snaps elsewhere */}
      {check.snapped && (
        <polygon points={pts(footprint({ ...item, position: hand, rotationY: check.pose.rotationY }))} fill="none" stroke="#a1a1aa" strokeWidth="0.015" strokeDasharray="0.05 0.04" />
      )}
      <polygon points={pts(corners)} fill={fill} stroke={color} strokeWidth="0.035" />
      <line x1={cx + fx * (d / 2)} y1={cz + fz * (d / 2)} x2={cx + fx * (d / 2 + 0.12)} y2={cz + fz * (d / 2 + 0.12)} stroke={color} strokeWidth="0.025" />
      {(() => {
        const { lines, fs } = fitLabel(short(item.label), corners);
        return lines.map((line, k) => (
          <text key={k} x={cx} y={cz + fs * 1.15 * (k - (lines.length - 1) / 2)} fontSize={fs} fill="#18181b" textAnchor="middle" dominantBaseline="middle" fontWeight={600}>
            {line}
          </text>
        ));
      })()}
      {note && (
        <text x={cx} y={Math.max(...zs) + 0.12} fontSize="0.085" fill={color} textAnchor="middle" dominantBaseline="middle" fontWeight={600}>
          {note.length > 60 ? note.slice(0, 59) + "..." : note}
        </text>
      )}
      <text x={cx} y={Math.min(...zs) - 0.08} fontSize="0.07" fill="#71717a" textAnchor="middle" dominantBaseline="middle">
        R to turn
      </text>
    </g>
  );
}

function short(label: string) {
  const s = label.split(",")[0];
  return s.length > 26 ? s.slice(0, 25) + "..." : s;
}

/** Wrap a label into lines that fit the footprint's on-screen width, shrinking the font if a word is too long. */
function fitLabel(label: string, corners: Pt[]) {
  const xs = corners.map((c) => c[0]);
  const width = Math.max(...xs) - Math.min(...xs) - 0.06;
  const charW = 0.56; // average glyph width as a fraction of font size
  const words = label.split(/\s+/);
  const longest = Math.max(...words.map((w) => w.length));
  const fs = Math.max(0.055, Math.min(0.1, width / (longest * charW)));
  const maxChars = Math.max(1, Math.floor(width / (fs * charW)));
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= maxChars) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  return { lines: lines.slice(0, 3), fs };
}
