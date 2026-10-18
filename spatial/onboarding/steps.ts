import type { Gesture } from "./mascot/Mascot";

export type TourVariant = "web" | "touch" | "vr";

/** Names used in data-tour="..." on the room UI. */
export type TourTarget = "room" | "talk" | "add" | "basket" | "inventory" | "undo";

export type TourStep = {
  id: string;
  /** Element to spotlight. "room" (or a missing element on a required step) centres the card instead. */
  target: TourTarget;
  /** Skip the step when its target is not on screen. */
  optional: boolean;
  title: string;
  body: string;
  keys?: string[];
  gesture: Gesture;
};

const WEB: TourStep[] = [
  { id: "look", target: "room", optional: false, gesture: "wave", title: "Hey, welcome home", body: "Click the room to look around, then walk with WASD. Esc or Tab frees your cursor.", keys: ["Click", "W A S D", "Esc"] },
  { id: "talk", target: "talk", optional: true, gesture: "point", title: "Just say it", body: "Hold Space and ask, like “a couch under $300 that fits here.”", keys: ["Hold Space"] },
  { id: "add", target: "add", optional: true, gesture: "point", title: "Add a piece", body: "Browse furniture and drop it right in.", keys: ["F"] },
  { id: "edit", target: "undo", optional: false, gesture: "think", title: "Make it yours", body: "Click any piece. G picks it up, R turns it, Del puts it away. Undo has your back.", keys: ["G", "R", "Del", "Ctrl Z"] },
  { id: "inventory", target: "inventory", optional: true, gesture: "point", title: "Put away, not gone", body: "Stashed pieces wait here. Drag one back into the room.", keys: ["I"] },
  { id: "basket", target: "basket", optional: true, gesture: "celebrate", title: "Your basket", body: "Everything you pick lands here. Test checkout is one tap, no real charge.", keys: ["B"] },
];

const TOUCH: TourStep[] = [
  { id: "look", target: "room", optional: false, gesture: "wave", title: "Hey, welcome home", body: "Drag to look around. Use the pad to walk." },
  { id: "talk", target: "talk", optional: true, gesture: "point", title: "Just say it", body: "Tap the mic and ask, like “a rug under $150.” Tap again to stop." },
  { id: "add", target: "add", optional: true, gesture: "point", title: "Add a piece", body: "Browse furniture and drop it right in." },
  { id: "edit", target: "undo", optional: false, gesture: "think", title: "Make it yours", body: "Tap a piece to move it, turn it, or put it away. Undo has your back." },
  { id: "inventory", target: "inventory", optional: true, gesture: "point", title: "Put away, not gone", body: "Stashed pieces wait here. Drag one back into the room." },
  { id: "basket", target: "basket", optional: true, gesture: "celebrate", title: "Your basket", body: "Your picks land here. Test checkout is one tap, no real charge." },
];

// The page overlay is hidden inside a headset session, so this runs before entering VR.
const VR: TourStep[] = [
  { id: "look", target: "room", optional: false, gesture: "wave", title: "Hey, welcome home", body: "Tap Enter VR to step inside your room." },
  { id: "hands", target: "room", optional: false, gesture: "think", title: "In VR", body: "Trigger selects. Grip grabs. Thumbstick walks.", keys: ["Trigger", "Grip", "Stick"] },
  { id: "talk", target: "talk", optional: true, gesture: "point", title: "Just say it", body: "Tap the pill and ask for what you want." },
  { id: "basket", target: "basket", optional: true, gesture: "celebrate", title: "Your basket", body: "Your picks land here. Test checkout is one tap." },
];

export const STEPS: Record<TourVariant, TourStep[]> = { web: WEB, touch: TOUCH, vr: VR };

export const findTarget = (name: TourTarget): HTMLElement | null =>
  typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-tour="${name}"]`);

/** A target counts only when it is actually laid out on screen. */
export function visibleRect(el: HTMLElement | null): DOMRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  return r;
}

/** Steps for this variant whose targets exist right now. */
export function availableSteps(variant: TourVariant): TourStep[] {
  return STEPS[variant].filter((s) => !s.optional || visibleRect(findTarget(s.target)));
}
