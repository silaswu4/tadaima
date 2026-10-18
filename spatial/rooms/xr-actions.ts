import type { FurnitureCategory, ProductCandidate, ShopRequest, ShopResult } from "../../backend/contracts";

/** Keep an active preview reachable even when it came from Fetch or a later result. */
export function roomXRProducts(results: readonly ShopResult[], pending: ProductCandidate | null): Array<{ product: ProductCandidate; source?: ShopResult["source"] }> {
  const visible: Array<{ product: ProductCandidate; source?: ShopResult["source"] }> = results.filter((entry) => entry.fits).slice(0, 3).map(({ product, source }) => ({ product, source }));
  if (pending && !visible.some((entry) => entry.product.id === pending.id)) {
    if (visible.length === 3) visible.pop();
    visible.push({ product: pending, source: results.find((entry) => entry.product.id === pending.id)?.source });
  }
  return visible;
}

type XRAction = { id: string; label: string; detail?: string; disabled?: boolean };
type XRActionState = {
  connected: boolean;
  busy: boolean;
  pending: boolean;
  moving: boolean;
  selected: { label: string; locked: boolean; stored: boolean } | null;
};

const PRESETS = [
  { id: "search-chair", category: "chair", label: "Find chairs", maxPriceUsd: 300 },
  { id: "search-rug", category: "rug", label: "Find rugs", maxPriceUsd: 300 },
  { id: "search-lamp", category: "lamp", label: "Find lamps", maxPriceUsd: 150 },
] as const satisfies readonly { id: string; category: FurnitureCategory; label: string; maxPriceUsd: number }[];

/** Explicit preset arguments avoid React's setCategory/then-search stale-state race. */
export function roomXRSearch(id: string, merchant: "IKEA" | "Target"): Omit<ShopRequest, "spot"> | null {
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset ? { category: preset.category, merchant, maxPriceUsd: preset.maxPriceUsd, live: false } : null;
}

/** A bounded, screen-independent set of controls; never includes unlock or payment. */
export function roomXRActions(state: XRActionState): XRAction[] {
  const unavailable = !state.connected || state.busy || state.moving;
  const selectedDetail = state.selected?.locked ? "Locked: exit VR to unlock this piece."
    : state.selected ? state.selected.label : "Point at a piece and press trigger first.";
  const cannotEdit = unavailable || state.pending || !state.selected || state.selected.locked || state.selected.stored;
  return [
    ...PRESETS.map((preset) => ({ id: preset.id, label: preset.label, detail: `Catalog · up to $${preset.maxPriceUsd} · at your floor spot`, disabled: unavailable })),
    { id: "rotate-selected", label: "Rotate 45°", detail: selectedDetail, disabled: Boolean(cannotEdit) },
    { id: "store-selected", label: "Put away", detail: selectedDetail, disabled: Boolean(cannotEdit) },
    { id: "cancel-preview", label: "Cancel preview", detail: "Nothing is added until you confirm placement.", disabled: state.busy || !state.pending },
  ];
}
