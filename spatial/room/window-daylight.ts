import type { PointXZ, RoomGeometry } from "../../backend/contracts";

export type WindowDaylight = {
  id: string; position: [number, number, number];
  inward: [number, 0, number]; width: number; height: number; area: number;
};

/** Strict interior test; the boundary itself is not inside a room. */
export function insideFloor(point: PointXZ, geometry: RoomGeometry): boolean {
  const [x, z] = point;
  return geometry.rooms.some(({ floorPolygon: polygon }) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  });
}

/** Geometry-driven overcast proxies, not solar orientation or measured lux. */
export function planWindowDaylight(geometry: RoomGeometry, maximum = 8): WindowDaylight[] {
  const walls = new Map(geometry.walls.map((wall) => [wall.id, wall]));
  const lights: WindowDaylight[] = [];
  for (const opening of geometry.openings) {
    if (opening.kind !== "window") continue;
    const wall = walls.get(opening.wallId);
    if (!wall) continue;
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dz);
    if (length <= 1e-8 || opening.width <= 0 || opening.height <= 0) continue;
    const center = opening.offset + opening.width / 2;
    const x = wall.start[0] + dx * center / length, z = wall.start[1] + dz * center / length;
    let nx = -dz / length, nz = dx / length;
    const probe = Math.max(.001, Math.min(.01, opening.width / 10));
    const a = insideFloor([x + nx * probe, z + nz * probe], geometry);
    const b = insideFloor([x - nx * probe, z - nz * probe], geometry);
    // Both sides occupied is a partition; neither occupied is ungrounded.
    if (a === b) continue;
    if (!a) { nx = -nx; nz = -nz; }
    const exterior = wall.thickness / 2 + .025;
    lights.push({ id: opening.id, position: [x - nx * exterior, opening.sillHeight + opening.height / 2, z - nz * exterior],
      inward: [nx, 0, nz], width: opening.width, height: opening.height, area: opening.width * opening.height });
  }
  return lights.sort((a, b) => b.area - a.area || a.id.localeCompare(b.id, "en"))
    .slice(0, Math.max(0, Math.min(8, Math.floor(maximum))));
}
