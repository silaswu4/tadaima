import type { RoomPlan } from "../../backend/contracts";

type Point = readonly [number, number];
export type NavigationPosition = readonly [number, number, number];
type Segment = { a: Point; b: Point; padding: number };
type Obstacle = { x: number; z: number; halfWidth: number; halfDepth: number; cos: number; sin: number };
export type NavigationWorld = {
  readonly radius: number;
  readonly eyeHeight: number;
  readonly floors: readonly (readonly Point[])[];
  readonly walls: readonly Segment[];
  readonly furniture: readonly Obstacle[];
};
export type NavigationSpawn = { ok: true; position: NavigationPosition } | { ok: false; reason: string };

const finite = (n: number) => Number.isFinite(n);
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

function inPolygon([x, z]: Point, polygon: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segmentDistance(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

/** Snapshot meter-based, Y-up geometry. Floor-level doors are walkable, windows are solid. */
export function createNavigationWorld(plan: RoomPlan, options: { radius?: number; eyeHeight?: number } = {}): NavigationWorld {
  const radius = options.radius ?? .18, eyeHeight = options.eyeHeight ?? 1.6;
  if (!finite(radius) || radius < .05 || radius > 1 || !finite(eyeHeight) || eyeHeight < .5 || eyeHeight > 2.5) throw new Error("Invalid navigation body dimensions.");
  const floors = plan.geometry.rooms.filter((room) => room.height >= eyeHeight + .1 && room.floorPolygon.length >= 3)
    .map((room) => room.floorPolygon.map(([x, z]) => [x, z] as Point));
  const walls: Segment[] = [];
  for (const wall of plan.geometry.walls) {
    if (wall.height <= .08) continue;
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1], length = Math.hypot(dx, dz);
    if (!length) continue;
    const doors = plan.geometry.openings.filter((o) => o.wallId === wall.id && o.kind === "door" && o.sillHeight <= .08 && o.height + o.sillHeight >= eyeHeight + .1)
      .map((o) => [clamp(o.offset, 0, length), clamp(o.offset + o.width, 0, length)])
      .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let start = 0;
    const add = (a: number, b: number) => { if (b > a) walls.push({ a: [wall.start[0] + dx * a / length, wall.start[1] + dz * a / length], b: [wall.start[0] + dx * b / length, wall.start[1] + dz * b / length], padding: wall.thickness / 2 }); };
    for (const [a, b] of doors) { add(start, a); start = Math.max(start, b); }
    add(start, length);
  }
  const furniture: Obstacle[] = [];
  for (const item of plan.items) {
    if (item.stored) continue;
    const product = item.productId ? plan.products.find((entry) => entry.id === item.productId) : undefined;
    const size = product?.dimensions ?? item.dimensions;
    if (!size || !size.every((n) => finite(n) && n > 0) || item.position[1] >= eyeHeight + .1 || item.position[1] + size[1] <= .08) continue;
    furniture.push({ x: item.position[0], z: item.position[2], halfWidth: size[0] / 2, halfDepth: size[2] / 2, cos: Math.cos(item.rotationY), sin: Math.sin(item.rotationY) });
  }
  return { radius, eyeHeight, floors, walls, furniture };
}

/** Circle vs oriented furniture footprints and wall capsules; floor must support the body. */
export function canNavigateAt(world: NavigationWorld, point: Point): boolean {
  if (!point.every(finite)) return false;
  const onFloor = (p: Point) => world.floors.some((floor) => inPolygon(p, floor));
  if (!onFloor(point)) return false;
  // Union probes allow adjacent rooms through their shared doorway. Wall capsules
  // supply exact clearance at structural edges; probes also constrain missing walls.
  for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12;
    if (!onFloor([point[0] + Math.cos(angle) * world.radius, point[1] + Math.sin(angle) * world.radius])) return false;
  }
  for (const wall of world.walls) if (segmentDistance(point, wall.a, wall.b) < world.radius + wall.padding - 1e-7) return false;
  for (const item of world.furniture) {
    const dx = point[0] - item.x, dz = point[1] - item.z;
    const x = item.cos * dx - item.sin * dz, z = item.sin * dx + item.cos * dz;
    if (Math.hypot(Math.max(Math.abs(x) - item.halfWidth, 0), Math.max(Math.abs(z) - item.halfDepth, 0)) < world.radius - 1e-7) return false;
  }
  return true;
}

/** Returns an explicit failure when no safe floor position exists, never an unsafe camera fallback. */
export function findNavigationSpawn(world: NavigationWorld, preferred?: Point): NavigationSpawn {
  if (preferred && canNavigateAt(world, preferred)) return { ok: true, position: [preferred[0], world.eyeHeight, preferred[1]] };
  const points = world.floors.flat();
  if (!points.length) return { ok: false, reason: "This room has no supported floor at standing height." };
  const minX = Math.min(...points.map((p) => p[0])), maxX = Math.max(...points.map((p) => p[0]));
  const minZ = Math.min(...points.map((p) => p[1])), maxZ = Math.max(...points.map((p) => p[1]));
  const target: Point = preferred ?? [(minX + maxX) / 2, (minZ + maxZ) / 2];
  // A bounded grid handles concave outlines and furniture covering the centroid.
  const step = Math.max(.15, Math.sqrt((maxX - minX) * (maxZ - minZ) / 18000));
  let best: Point | undefined, distance = Infinity;
  for (let x = minX + world.radius; x <= maxX - world.radius; x += step) {
    for (let z = minZ + world.radius; z <= maxZ - world.radius; z += step) {
      const d = Math.hypot(x - target[0], z - target[1]);
      if (d < distance && canNavigateAt(world, [x, z])) { best = [x, z]; distance = d; }
    }
  }
  return best ? { ok: true, position: [best[0], world.eyeHeight, best[1]] } : { ok: false, reason: "No clear standing position was found. Use overview or review this room's layout." };
}

/** Deterministic horizontal locomotion, with capped elapsed time and substeps to prevent tunneling. */
export function moveNavigation(world: NavigationWorld, position: NavigationPosition, input: { forward: number; right: number; yaw: number; sprint?: boolean }, deltaSeconds: number): NavigationPosition {
  if (![...position, input.forward, input.right, input.yaw, deltaSeconds].every(finite)) return position;
  const magnitude = Math.hypot(input.forward, input.right);
  if (!magnitude || deltaSeconds <= 0) return position;
  const forward = input.forward / Math.max(1, magnitude), right = input.right / Math.max(1, magnitude);
  const distance = Math.min(deltaSeconds, .1) * (input.sprint ? 3.2 : 2);
  const dx = (right * Math.cos(input.yaw) - forward * Math.sin(input.yaw)) * distance;
  const dz = (-right * Math.sin(input.yaw) - forward * Math.cos(input.yaw)) * distance;
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dz) / Math.min(world.radius / 3, .05)));
  let x = position[0], z = position[2];
  for (let i = 0; i < count; i++) {
    const stepX = dx / count, stepZ = dz / count;
    const nextX = x + stepX, nextZ = z + stepZ;
    if (canNavigateAt(world, [nextX, nextZ])) { x = nextX; z = nextZ; }
    else {
      const candidates: Point[] = [[stepX, 0], [0, stepZ]];
      const stepLength = Math.hypot(stepX, stepZ);
      // Project onto nearby wall tangents as well as the world axes. Without
      // this, a single movement key sticks to every diagonal scanned wall.
      for (const wall of world.walls) {
        if (segmentDistance([x, z], wall.a, wall.b) > world.radius + wall.padding + stepLength + .001) continue;
        const wx = wall.b[0] - wall.a[0], wz = wall.b[1] - wall.a[1], length = Math.hypot(wx, wz);
        const dot = (stepX * wx + stepZ * wz) / (length * length);
        candidates.push([wx * dot, wz * dot]);
      }
      for (const item of world.furniture) {
        const ox = x - item.x, oz = z - item.z;
        const localX = item.cos * ox - item.sin * oz, localZ = item.sin * ox + item.cos * oz;
        const nx = localX - clamp(localX, -item.halfWidth, item.halfWidth), nz = localZ - clamp(localZ, -item.halfDepth, item.halfDepth);
        const normalLength = Math.hypot(nx, nz);
        if (!normalLength || normalLength > world.radius + stepLength + .001) continue;
        const normalX = (item.cos * nx + item.sin * nz) / normalLength, normalZ = (-item.sin * nx + item.cos * nz) / normalLength;
        const inward = Math.min(0, stepX * normalX + stepZ * normalZ);
        candidates.push([stepX - inward * normalX, stepZ - inward * normalZ]);
      }
      let best: Point = [0, 0], progress = 0;
      for (const candidate of candidates) {
        const dot = candidate[0] * stepX + candidate[1] * stepZ;
        if (dot > progress && canNavigateAt(world, [x + candidate[0], z + candidate[1]])) { best = candidate; progress = dot; }
      }
      x += best[0]; z += best[1];
    }
  }
  return [x, world.eyeHeight, z];
}

/** Keystrokes in product controls or text entry must never move the shopper. */
export function isNavigationInputTarget(target: EventTarget | null): boolean {
  const element = target as { isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  return !!element && (!!element.isContentEditable || !!element.closest?.("input,textarea,select,button,a,[contenteditable],[role='textbox'],[role='slider'],[role='button']"));
}

type NavigationCamera = {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  rotation: { y: number; set(x: number, y: number, z: number, order?: "YXZ"): unknown };
  quaternion?: { x: number; y: number; z: number; w: number };
};

/** Browser adapter. The host owns overview/walk UI and calls update once per frame. */
export function createFirstPersonNavigation(camera: NavigationCamera, canvas: HTMLCanvasElement, world: NavigationWorld, callbacks: { onPointerLock?: (locked: boolean) => void; onError?: (message: string) => void } = {}) {
  const doc = canvas.ownerDocument, win = doc.defaultView;
  let active = false, disposed = false, yaw = 0, pitch = 0, mobileForward = 0, mobileRight = 0;
  let touch: { id: number; x: number; y: number } | null = null;
  const keys = new Set<string>();
  const clear = () => { keys.clear(); mobileForward = 0; mobileRight = 0; touch = null; };
  const applyLook = () => camera.rotation.set(pitch, yaw, 0, "YXZ");
  const lookBy = (dx: number, dy: number) => {
    if (!active || !finite(dx) || !finite(dy)) return;
    yaw -= dx * .002; pitch = clamp(pitch - dy * .002, -Math.PI / 2 + .06, Math.PI / 2 - .06); applyLook();
  };
  const requestPointerLock = () => {
    if (!active || disposed || !canvas.requestPointerLock || doc.pointerLockElement === canvas) return;
    const unavailable = () => { if (!disposed && active) callbacks.onError?.("Mouse capture is unavailable. Drag to look, or use touch controls."); };
    try { const request = canvas.requestPointerLock(); if (request && typeof request.catch === "function") request.catch(unavailable); }
    catch { unavailable(); }
  };
  const keydown = (event: KeyboardEvent) => {
    if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isNavigationInputTarget(event.target)) return;
    // Multiple room canvases can coexist during navigation/transitions. Only
    // the focused or mouse-locked canvas owns document-level keyboard input.
    if (doc.pointerLockElement ? doc.pointerLockElement !== canvas : doc.activeElement !== canvas && event.target !== canvas) return;
    if (event.code === "Escape") { clear(); if (doc.pointerLockElement === canvas) doc.exitPointerLock(); return; }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) { keys.add(event.code); event.preventDefault(); }
  };
  const keyup = (event: KeyboardEvent) => { keys.delete(event.code); };
  const pointerLockChange = () => { clear(); callbacks.onPointerLock?.(doc.pointerLockElement === canvas); };
  const mousemove = (event: MouseEvent) => { if (doc.pointerLockElement === canvas) lookBy(event.movementX, event.movementY); };
  const pointerdown = (event: PointerEvent) => {
    if (!active || event.button !== 0 || event.isPrimary === false || touch && touch.id !== event.pointerId) return;
    canvas.focus({ preventScroll: true });
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
    if (event.pointerType === "mouse" && typeof canvas.requestPointerLock === "function") requestPointerLock();
  };
  const pointermove = (event: PointerEvent) => {
    if (doc.pointerLockElement === canvas || touch?.id !== event.pointerId) return;
    lookBy(event.clientX - touch.x, event.clientY - touch.y); touch = { id: touch.id, x: event.clientX, y: event.clientY };
  };
  const pointerup = (event: PointerEvent) => { if (touch?.id === event.pointerId) touch = null; };
  const focusin = (event: FocusEvent) => { if (event.target !== canvas) clear(); };
  const visibilitychange = () => { if (doc.hidden) clear(); };
  doc.addEventListener("keydown", keydown); doc.addEventListener("keyup", keyup);
  doc.addEventListener("pointerlockchange", pointerLockChange); doc.addEventListener("mousemove", mousemove);
  doc.addEventListener("focusin", focusin);
  doc.addEventListener("visibilitychange", visibilitychange);
  win?.addEventListener("blur", clear);
  canvas.addEventListener("pointerdown", pointerdown); canvas.addEventListener("pointermove", pointermove);
  canvas.addEventListener("pointerup", pointerup); canvas.addEventListener("pointercancel", pointerup);
  canvas.addEventListener("lostpointercapture", pointerup);
  return {
    get active() { return active; },
    get pointerLocked() { return doc.pointerLockElement === canvas; },
    enter(preferred?: Point): NavigationSpawn {
      if (disposed) return { ok: false, reason: "Navigation has been disposed." };
      const spawn = findNavigationSpawn(world, preferred);
      if (!spawn.ok) return spawn;
      active = true; clear(); yaw = camera.rotation.y; pitch = 0;
      // OrbitControls can leave an XYZ Euler angle whose Y component is not
      // the horizontal heading. Flatten the actual camera forward direction.
      if (camera.quaternion) {
        const { x, y, z, w } = camera.quaternion;
        const forwardX = -2 * (x * z + w * y), forwardZ = -(1 - 2 * (x * x + y * y));
        if (Math.hypot(forwardX, forwardZ) > 1e-5) yaw = Math.atan2(-forwardX, -forwardZ);
      }
      camera.position.set(...spawn.position); applyLook();
      if (canvas.tabIndex < 0) canvas.tabIndex = 0;
      canvas.focus({ preventScroll: true }); return spawn;
    },
    exit() { active = false; clear(); if (doc.pointerLockElement === canvas) doc.exitPointerLock(); },
    update(deltaSeconds: number) {
      if (!active || disposed) return;
      const forward = mobileForward + (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
      const right = mobileRight + (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      camera.position.set(...moveNavigation(world, [camera.position.x, camera.position.y, camera.position.z], { forward, right, yaw, sprint: keys.has("ShiftLeft") || keys.has("ShiftRight") }, deltaSeconds));
    },
    setMoveInput(forward: number, right: number) { mobileForward = finite(forward) ? clamp(forward, -1, 1) : 0; mobileRight = finite(right) ? clamp(right, -1, 1) : 0; },
    lookBy, requestPointerLock,
    dispose() {
      active = false; disposed = true; clear(); if (doc.pointerLockElement === canvas) doc.exitPointerLock();
      doc.removeEventListener("keydown", keydown); doc.removeEventListener("keyup", keyup);
      doc.removeEventListener("pointerlockchange", pointerLockChange); doc.removeEventListener("mousemove", mousemove);
      doc.removeEventListener("focusin", focusin);
      doc.removeEventListener("visibilitychange", visibilitychange);
      win?.removeEventListener("blur", clear);
      canvas.removeEventListener("pointerdown", pointerdown); canvas.removeEventListener("pointermove", pointermove);
      canvas.removeEventListener("pointerup", pointerup); canvas.removeEventListener("pointercancel", pointerup);
      canvas.removeEventListener("lostpointercapture", pointerup);
    },
  };
}
