/** Clamp external locomotion axes; nonfinite/malformed values must never move the camera. */
export function normalizeWalkInput(input: { forward: number; right: number }): { forward: number; right: number } {
  const axis = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return { forward: axis(input?.forward), right: axis(input?.right) };
}
