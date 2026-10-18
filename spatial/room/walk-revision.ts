import type { RoomPlan } from "../../backend/contracts";

const canonical = (plan: RoomPlan) => JSON.stringify({ ...plan, revision: 0 });

/** Revisions describe accepted canonical edits, not repeated item notifications or view state. */
export function createWalkRevisionTracker(initial: RoomPlan) {
  let last = canonical(initial);
  let revision = initial.revision;
  return {
    accept(next: RoomPlan): number {
      const snapshot = canonical(next);
      if (snapshot !== last) {
        revision += 1;
        last = snapshot;
      }
      return revision;
    },
  };
}
