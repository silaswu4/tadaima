import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import type { Money, PlacedItem, PointXZ, RoomPlan } from "@/backend/contracts";

/**
 * Room plan -> 1200x800 PNG for chat (ASI:One markdown images, card heroes).
 * Geometry goes in one inline <svg> (resvg draws it). All text goes in absolutely
 * positioned divs (satori lays it out with Paper Mono). Never put <text> in the
 * svg: resvg has no system fonts here. Satori also needs a static ttf, not the
 * variable woff2.
 */

export const W = 1200;
export const H = 800;
const PANEL = 400;
const INK = "#000";
const PAPER = "#fff";
const MUTE = "#8a8a8a";
const RED = "#e5222b";
const MAX_ROWS = 8;

export interface RenderOptions {
  /** Header line. Defaults to the room label. */
  title?: string;
  headers?: Record<string, string>;
}

let fontData: Promise<Buffer> | null = null;
const font = () => (fontData ??= readFile(join(process.cwd(), "app/fonts/PaperMono-Regular.ttf")));

async function png(el: ReactElement, opts: RenderOptions) {
  const data = await font();
  return new ImageResponse(el, {
    width: W,
    height: H,
    fonts: [{ name: "Paper Mono", data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, weight: 400, style: "normal" }],
    headers: opts.headers,
  });
}

export const renderPlanPng = (plan: RoomPlan, opts: RenderOptions = {}) => png(PlanImage({ plan, title: opts.title }), opts);
export const renderDiffPng = (before: RoomPlan, after: RoomPlan, opts: RenderOptions = {}) => png(PlanImage({ plan: after, base: before, title: opts.title }), opts);

type Status = "same" | "new" | "replaced" | "moved" | "removed" | "stored";
interface Drawn {
  item: PlacedItem;
  status: Status;
  /** Previous pose for moved or replaced items. */
  ghost?: PlacedItem;
  n: number;
}

const fmt = (m: Money | null | undefined) =>
  m ? `$${(m.amountMinor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "?";
const usd = (amountMinor: number) => fmt({ amountMinor, currency: "USD" });
const inRoom = (plan: RoomPlan) => plan.items.filter((it) => !it.stored);

function corners(it: PlacedItem): Array<[number, number]> {
  const [w, , d] = it.dimensions ?? [0.4, 0.4, 0.4];
  const c = Math.cos(it.rotationY);
  const s = Math.sin(it.rotationY);
  const local: Array<[number, number]> = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  // rotation about +Y (right-handed): x' = x cos + z sin, z' = -x sin + z cos
  return local.map(([lx, lz]) => [it.position[0] + lx * c + lz * s, it.position[2] - lx * s + lz * c]);
}

function price(plan: RoomPlan, it: PlacedItem) {
  if (it.origin !== "proposed_purchase") return null;
  return plan.products.find((p) => p.id === it.productId)?.price ?? null;
}

const spend = (plan: RoomPlan) => inRoom(plan).reduce((t, it) => t + (price(plan, it)?.amountMinor ?? 0), 0);

export function diffItems(plan: RoomPlan, base?: RoomPlan): Drawn[] {
  const out: Drawn[] = [];
  const baseItems = base ? inRoom(base) : [];
  let n = 1;
  for (const it of inRoom(plan)) {
    const prev = baseItems.find((b) => b.id === it.id);
    let status: Status = "same";
    if (base && !prev) status = "new";
    else if (prev && prev.productId !== it.productId) status = "replaced";
    else if (
      prev &&
      (Math.hypot(prev.position[0] - it.position[0], prev.position[2] - it.position[2]) > 0.02 || Math.abs(prev.rotationY - it.rotationY) > 0.01)
    )
      status = "moved";
    out.push({ item: it, status, ghost: status === "moved" || status === "replaced" ? prev : undefined, n: n++ });
  }
  for (const b of baseItems) {
    if (inRoom(plan).some((it) => it.id === b.id)) continue;
    const stored = plan.items.some((it) => it.id === b.id && it.stored);
    out.push({ item: b, status: stored ? "stored" : "removed", n: n++ });
  }
  return out;
}

const pts = (p: ReadonlyArray<PointXZ>, tx: (x: number, z: number) => [number, number]) => p.map(([x, z]) => tx(x, z).join(",")).join(" ");

// called as a function: satori wants plain svg nodes inside <svg>
function lockIcon(key: string, x: number, y: number, s: number, fill: string) {
  return (
    <g key={key}>
      <path d={`M ${x - s * 0.28} ${y - s * 0.05} v ${-s * 0.18} a ${s * 0.28} ${s * 0.28} 0 0 1 ${s * 0.56} 0 v ${s * 0.18}`} fill="none" stroke={fill} stroke-width={s * 0.12} />
      <rect x={x - s * 0.4} y={y - s * 0.05} width={s * 0.8} height={s * 0.55} rx={s * 0.08} fill={fill} />
    </g>
  );
}

function bounds(plan: RoomPlan) {
  const room = plan.geometry.rooms[0];
  const poly: PointXZ[] = room?.floorPolygon.length
    ? room.floorPolygon
    : plan.geometry.walls.flatMap((w) => [w.start, w.end]);
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  if (!xs.length) return { poly, minX: 0, maxX: 4, minZ: 0, maxZ: 4 };
  return { poly, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

export function PlanImage({ plan, base, title }: { plan: RoomPlan; base?: RoomPlan; title?: string }): ReactElement {
  const { poly, minX, maxX, minZ, maxZ } = bounds(plan);
  const areaW = W - PANEL - 40 - 80;
  const areaH = H - 120 - 90;
  const k = Math.min(areaW / Math.max(0.5, maxX - minX), areaH / Math.max(0.5, maxZ - minZ)); // px per meter
  const ox = 90 + (areaW - (maxX - minX) * k) / 2;
  const oy = 120 + (areaH - (maxZ - minZ) * k) / 2;
  const tx = (x: number, z: number): [number, number] => [ox + (x - minX) * k, oy + (z - minZ) * k];

  const drawn = diffItems(plan, base);
  // rugs first, then biggest footprint first so small things stay on top
  const order = [...drawn].sort((a, b) => {
    const ar = a.item.category === "rug" ? 0 : 1;
    const br = b.item.category === "rug" ? 0 : 1;
    if (ar !== br) return ar - br;
    const aa = (a.item.dimensions?.[0] ?? 0) * (a.item.dimensions?.[2] ?? 0);
    const ba = (b.item.dimensions?.[0] ?? 0) * (b.item.dimensions?.[2] ?? 0);
    return ba - aa;
  });

  const wallById = new Map(plan.geometry.walls.map((w) => [w.id, w]));
  const svg: ReactElement[] = [];

  svg.push(<polygon key="floor" points={pts(poly, tx)} fill={PAPER} />);
  for (const w of plan.geometry.walls) {
    const [x1, y1] = tx(...w.start);
    const [x2, y2] = tx(...w.end);
    svg.push(<line key={w.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={INK} stroke-width={Math.max(6, w.thickness * k)} stroke-linecap="square" />);
  }
  for (const o of plan.geometry.openings) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) || 1;
    const ux = (w.end[0] - w.start[0]) / len;
    const uz = (w.end[1] - w.start[1]) / len;
    const a: [number, number] = [w.start[0] + ux * o.offset, w.start[1] + uz * o.offset];
    const b: [number, number] = [a[0] + ux * o.width, a[1] + uz * o.width];
    const [x1, y1] = tx(...a);
    const [x2, y2] = tx(...b);
    const sw = Math.max(6, w.thickness * k) + 2;
    if (o.kind === "window") {
      svg.push(<line key={o.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={PAPER} stroke-width={sw - 4} />);
      svg.push(<line key={o.id + "c"} x1={x1} y1={y1} x2={x2} y2={y2} stroke={INK} stroke-width={1.5} />);
    } else {
      // gap plus swing arc; inward normal is right of the wall direction for this winding
      svg.push(<line key={o.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={PAPER} stroke-width={sw} />);
      const inward = tx(a[0] - uz * o.width, a[1] + ux * o.width);
      svg.push(<line key={o.id + "l"} x1={x1} y1={y1} x2={inward[0]} y2={inward[1]} stroke={INK} stroke-width={2} />);
      svg.push(<path key={o.id + "a"} d={`M ${inward[0]} ${inward[1]} A ${o.width * k} ${o.width * k} 0 0 0 ${x2} ${y2}`} fill="none" stroke={INK} stroke-width={1.5} stroke-dasharray="4 4" />);
    }
  }

  // dimension lines
  const [rx1, ry1] = tx(minX, minZ);
  const [rx2, ry2] = tx(maxX, maxZ);
  const dim = (key: string, x1: number, y1: number, x2: number, y2: number) => <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={INK} stroke-width={1.5} />;
  svg.push(dim("dimw", rx1, ry2 + 34, rx2, ry2 + 34), dim("dimw1", rx1, ry2 + 24, rx1, ry2 + 44), dim("dimw2", rx2, ry2 + 24, rx2, ry2 + 44));
  svg.push(dim("dimh", rx1 - 34, ry1, rx1 - 34, ry2), dim("dimh1", rx1 - 44, ry1, rx1 - 24, ry1), dim("dimh2", rx1 - 44, ry2, rx1 - 24, ry2));

  // previous poses under everything
  for (const d of order) {
    if (!d.ghost) continue;
    const g = d.ghost;
    svg.push(<polygon key={d.item.id + "g"} points={pts(corners(g), tx)} fill="none" stroke={d.status === "replaced" ? RED : MUTE} stroke-width={2} stroke-dasharray="7 5" />);
    if (d.status === "moved") {
      const [ax, ay] = tx(g.position[0], g.position[2]);
      const [bx, by] = tx(d.item.position[0], d.item.position[2]);
      svg.push(<line key={d.item.id + "arr"} x1={ax} y1={ay} x2={bx} y2={by} stroke={INK} stroke-width={2} stroke-dasharray="3 4" />);
    }
  }

  const labels: ReactElement[] = [];
  const badges: ReactElement[] = [];
  for (const d of order) {
    const it = d.item;
    const p = pts(corners(it), tx);
    const isRug = it.category === "rug";
    const gone = d.status === "removed" || d.status === "stored";
    const hl = d.status === "new" || d.status === "replaced";
    if (gone) {
      svg.push(<polygon key={it.id} points={p} fill={d.status === "removed" ? "url(#xhatch)" : "none"} stroke={d.status === "removed" ? RED : MUTE} stroke-width={2.5} stroke-dasharray="8 6" />);
    } else if (isRug) {
      svg.push(<polygon key={it.id} points={p} fill={hl ? "url(#hatchInk)" : "url(#hatch)"} stroke={INK} stroke-width={hl ? 3 : 1.5} />);
    } else {
      svg.push(<polygon key={it.id} points={p} fill={hl ? INK : PAPER} stroke={INK} stroke-width={hl ? 3 : 2.5} />);
      // seat back is the local -z edge
      if (it.category === "sofa" || it.category === "chair") {
        const c = corners(it);
        const [b1x, b1y] = tx(...c[0]);
        const [b2x, b2y] = tx(...c[1]);
        svg.push(<line key={it.id + "back"} x1={b1x} y1={b1y} x2={b2x} y2={b2y} stroke={hl ? PAPER : INK} stroke-width={8} />);
      }
    }
    // rugs sit under tables, so their badge goes on the back-left corner
    const rc = corners(it).reduce((m, c) => (c[0] + c[1] < m[0] + m[1] ? c : m));
    const [cx, cy] = isRug ? tx(rc[0] + 0.22, rc[1] + 0.22) : tx(it.position[0], it.position[2]);
    const r = 17;
    const bg = d.status === "removed" ? RED : d.status === "stored" ? MUTE : hl ? PAPER : INK;
    const fg = gone ? PAPER : hl ? INK : PAPER;
    badges.push(<circle key={it.id + "b"} cx={cx} cy={cy} r={r} fill={bg} stroke={hl ? INK : bg} stroke-width={2} />);
    labels.push(
      <div key={it.id + "n"} style={{ position: "absolute", left: cx - r, top: cy - r, width: r * 2, height: r * 2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: fg }}>
        {String(d.n)}
      </div>,
    );
    if (it.locked && !gone) {
      badges.push(<circle key={it.id + "lk"} cx={cx + 24} cy={cy - 18} r={13} fill={PAPER} stroke={INK} stroke-width={2} />);
      badges.push(lockIcon(it.id + "li", cx + 24, cy - 16, 16, INK));
    }
  }

  // panel
  const budget = plan.constraints.budget;
  const after = spend(plan);
  const before = base ? spend(base) : null;
  const seats = inRoom(plan).reduce((t, it) => t + (it.seats ?? 0), 0);
  const cap = budget?.amountMinor || Math.max(after, before ?? 0, 1);
  const pct = (v: number) => `${Math.min(100, (v / cap) * 100).toFixed(1)}%`;
  const over = budget ? after > budget.amountMinor : false;
  const tag: Record<Status, string> = { same: "", new: "NEW", replaced: "SWAP", moved: "MOVED", removed: "REMOVED", stored: "STORED" };
  const rows = drawn.slice(0, MAX_ROWS);
  const hidden = drawn.length - rows.length;
  const roomLabel = plan.geometry.rooms[0]?.label ?? "Room";

  return (
    <div style={{ width: W, height: H, display: "flex", background: PAPER, color: INK, fontFamily: "Paper Mono", position: "relative" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
        <defs>
          <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="10" stroke="#bdbdbd" stroke-width="2" />
          </pattern>
          <pattern id="hatchInk" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke={INK} stroke-width="3" />
          </pattern>
          <pattern id="xhatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="10" stroke="#f4b8bb" stroke-width="2" />
          </pattern>
        </defs>
        {svg}
        {badges}
        <line x1={W - PANEL} y1={40} x2={W - PANEL} y2={H - 40} stroke={INK} stroke-width={1.5} />
      </svg>

      <div style={{ position: "absolute", left: 40, top: 28, width: W - PANEL - 80, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 30, display: "flex" }}>{clip(title ?? roomLabel, 44)}</div>
        <div style={{ fontSize: 18, color: MUTE, marginTop: 4, display: "flex" }}>
          {`${plan.projectId} / rev ${base ? `${base.revision} to ${plan.revision}` : plan.revision} / top view`}
        </div>
      </div>
      <div style={{ position: "absolute", left: (rx1 + rx2) / 2 - 60, top: ry2 + 22, width: 120, display: "flex", justifyContent: "center", fontSize: 18, background: PAPER }}>
        {`${(maxX - minX).toFixed(2)} m`}
      </div>
      <div style={{ position: "absolute", left: rx1 - 34 - 60, top: (ry1 + ry2) / 2 - 12, width: 120, display: "flex", justifyContent: "center", fontSize: 18, background: PAPER, transform: "rotate(-90deg)" }}>
        {`${(maxZ - minZ).toFixed(2)} m`}
      </div>
      {labels}

      <div style={{ position: "absolute", left: W - PANEL + 32, top: 40, width: PANEL - 64, display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 16, color: MUTE, letterSpacing: 2 }}>NEW PURCHASES</div>
        <div style={{ display: "flex", alignItems: "flex-end", marginTop: 6 }}>
          <div style={{ fontSize: 44, color: over ? RED : INK }}>{usd(after)}</div>
          <div style={{ fontSize: 20, color: MUTE, marginLeft: 10, marginBottom: 8 }}>{budget ? `of ${fmt(budget)}` : ""}</div>
        </div>
        <div style={{ display: "flex", position: "relative", height: 18, border: `2px solid ${INK}`, marginTop: 10 }}>
          {before !== null ? <div style={{ position: "absolute", left: 0, top: 0, height: 14, width: pct(before), background: "#d6d6d6" }} /> : null}
          <div style={{ position: "absolute", left: 0, top: 0, height: 14, width: pct(after), background: over ? RED : INK }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, color: MUTE, marginTop: 6 }}>
          <div>{before !== null ? `was ${usd(before)}` : `${seats} seats`}</div>
          <div>
            {before !== null
              ? `${after - before <= 0 ? "-" : "+"}${usd(Math.abs(after - before))}`
              : budget
                ? `${usd(Math.max(0, budget.amountMinor - after))} left`
                : ""}
          </div>
        </div>

        <div style={{ fontSize: 16, color: MUTE, letterSpacing: 2, marginTop: 26 }}>ITEMS</div>
        {rows.map((d) => {
          const gone = d.status === "removed" || d.status === "stored";
          const pr = price(gone && base ? base : plan, d.item);
          const hl = d.status === "new" || d.status === "replaced";
          const tone = d.status === "removed" ? RED : d.status === "stored" ? MUTE : INK;
          return (
            <div key={d.item.id} style={{ display: "flex", alignItems: "center", marginTop: 9, fontSize: 18, color: tone }}>
              <div
                style={{
                  width: 28, height: 28, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0,
                  background: gone ? tone : hl ? PAPER : INK,
                  color: gone ? PAPER : hl ? INK : PAPER,
                  border: `2px solid ${gone ? tone : INK}`,
                }}
              >
                {String(d.n)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", marginLeft: 10, width: 232 }}>
                <div style={{ display: "flex", textDecoration: gone ? "line-through" : "none" }}>{clip(d.item.label.split(",")[0], 40)}</div>
                <div style={{ display: "flex", fontSize: 15, color: MUTE }}>
                  {[d.item.locked ? "locked" : d.item.origin === "existing_owned" ? "owned" : "", tag[d.status]].filter(Boolean).join("  ") || " "}
                </div>
              </div>
              <div style={{ display: "flex", width: 62, justifyContent: "flex-end" }}>{d.item.origin === "existing_owned" ? "own" : fmt(pr)}</div>
            </div>
          );
        })}
        {hidden > 0 ? <div style={{ display: "flex", fontSize: 15, color: MUTE, marginTop: 9 }}>{`+${hidden} more`}</div> : null}
      </div>
      <div style={{ position: "absolute", left: W - PANEL + 32, bottom: 28, display: "flex", fontSize: 14, color: MUTE }}>
        {base ? "black: new. red: removed. grey: stored." : "heavy edge: seat back. hatch: rug."}
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "..." : s);
