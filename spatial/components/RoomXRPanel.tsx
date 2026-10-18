"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FurnitureCategory } from "../../backend/contracts";
import type { WorkspaceXRShopping, WorkspaceXRLocomotion, WorkspaceXROffer, WorkspaceXRItem } from "../room/workspace-xr";
import { RoomProductCard, roomProductDimensions, roomProductMoney } from "./RoomProductCard";
import { CategoryGlyph, Icon } from "./room-icons";
import mark from "../assets/tadaima-mark.png";
import "./RoomExperience.css";
import "./RoomVoice.css";
import "./RoomXRPanel.css";

/** "agent" is the open room (no drawer): voice pill, captions and search results, as on the website. */
export type XRPanelTab = "agent" | "shop" | "room" | "basket" | "controls";
export type XRPanelProps = {
  state: WorkspaceXRShopping;
  locomotion: WorkspaceXRLocomotion;
  tab: XRPanelTab;
  onNavigate(tab: XRPanelTab): void;
  onAction(id: string): void;
  onPreviewOffer(id: string): void;
  onConfirmOffer(): void;
  onLocomotionToggle(): void;
  onExit(): void;
  onClose(): void;
  onLayout(): void;
};

const HOTBAR_SLOTS = 9;
const CATEGORIES: Array<[FurnitureCategory, string]> = [["sofa", "Sofas"], ["chair", "Chairs"], ["table", "Tables"], ["desk", "Desks"], ["storage", "Storage"], ["bed", "Beds"], ["rug", "Rugs"], ["lamp", "Lamps"], ["decor", "Decor"]];
const shortName = (label: string) => label.split(",")[0];

/**
 * The room website's own overlay markup and `room-x` classes, laid out for one in-world
 * panel. The XR adapter rasterizes this DOM onto a transparent texture and clicks these
 * same buttons, so the headset shows the website's UI floating over the room.
 */
export function RoomXRPanel(props: XRPanelProps) {
  const { state, tab, locomotion } = props;
  const [category, setCategory] = useState<FurnitureCategory>("chair");
  const actions = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const enabled = (id: string) => actions.has(id) && !actions.get(id)?.disabled;
  const pending = state.offers.find((offer) => offer.id === state.pendingOfferId);
  const canConfirm = Boolean(pending && state.canConfirm && !state.busy && pending.fits !== false && pending.withinBudget !== false);
  const agent = state.agent;
  const drawer = tab === "agent" ? null : tab;
  const stored = (state.inventory ?? []).filter((item) => item.stored);
  const selectedItem = (state.inventory ?? []).find((item) => item.selected && !item.stored);
  const selected = state.selectedItemLabel ? { ...selectedItem, label: state.selectedItemLabel, locked: state.selectedItemLocked ?? selectedItem?.locked } : null;
  const basket = state.basket ?? [];
  const results = !drawer && !pending && state.offers.length > 0;
  useLayoutEffect(() => { props.onLayout(); });

  /** Every ray target is a real button: same element, same click handler. Hover is drawn by the XR adapter. */
  function hit(id: string, className: string, label: ReactNode, onClick: () => void, options: { disabled?: boolean; ariaLabel?: string; pressed?: boolean; live?: boolean; filled?: boolean } = {}) {
    return <button type="button" className={className} data-xr-id={id} tabIndex={-1}
      data-live={options.live || undefined} data-filled={options.filled || undefined} aria-pressed={options.pressed} aria-label={options.ariaLabel} disabled={options.disabled} onClick={onClick}>{label}</button>;
  }
  const action = (id: string, className: string, label: ReactNode, ariaLabel?: string, filled?: boolean) => {
    const voice = id.startsWith("voice-");
    // Locked pieces, an open preview or no selection protect the piece even if a stale action list allows it.
    const protectedEdit = (id === "rotate-selected" || id === "store-selected") && (Boolean(state.selectedItemLocked) || Boolean(state.pendingOfferId) || !state.selectedItemLabel);
    return hit(`action:${id}`, className, label, () => props.onAction(id), { disabled: !enabled(id) || (!voice && state.busy) || protectedEdit, ariaLabel, filled });
  };
  // A pill always opens its drawer (a missed second press must not slam it shut); × closes it.
  const toggle = (next: XRPanelTab) => props.onNavigate(next);

  // Measured products need size and price; label-only offers defer that check to the room session.
  const placeable = (offer: WorkspaceXROffer) => offer.fits !== false && (!offer.product
    || (Boolean(offer.product.dimensions && offer.product.price) && offer.product.availability !== "unavailable"));
  function product(offer: WorkspaceXROffer) {
    const id = `preview:${offer.id}`, previewed = state.pendingOfferId === offer.id;
    if (!offer.product) return <li key={offer.id} className="room-product-card">
      <div className="room-product-card__body">
        <p className="room-product-card__name">{shortName(offer.label)}</p>
        {offer.detail ? <p className="room-product-card__meta"><span>{offer.detail}</span></p> : null}
        {placeable(offer) ? hit(id, "room-product-card__action", previewed ? "In your room" : "Add to room", () => props.onPreviewOffer(offer.id),
          { disabled: state.busy || offer.withinBudget === false || previewed }) : null}
      </div>
    </li>;
    return <RoomProductCard key={offer.id} product={offer.product} fits={offer.fits} withinBudget={offer.withinBudget} problems={offer.problems}
      source={offer.source} actionLabel={state.pendingOfferId === offer.id ? "In your room" : "Add to room"} onPreview={() => props.onPreviewOffer(offer.id)}
      disabled={state.busy || offer.withinBudget === false || state.pendingOfferId === offer.id}
      canPreview={placeable(offer)}
      xrId={`preview:${offer.id}`} linkToSource={false} rasterizable onLayout={props.onLayout} />;
  }

  const head = (title: string, sub?: string) => <div className="room-x__panel-head">
    <div><h2 className="room-x__panel-title">{title}</h2>{sub ? <p className="room-x__panel-sub">{sub}</p> : null}</div>
    {hit("tab-agent", "room-x__icon-btn", Icon.close, () => props.onNavigate("agent"), { ariaLabel: "Close" })}
  </div>;
  const line = (item: WorkspaceXRItem, end: ReactNode) => <li key={item.id} className="room-x__line">
    <div className="room-x__line-main"><p className="room-x__line-name">{shortName(item.label)}</p><p className="room-x__line-dims">{roomProductDimensions(item.dimensions)}</p></div>
    <div className="room-x__line-end">{end}</div>
  </li>;

  return <div className="room-x room-x--vr" data-ready data-drawer={drawer ?? undefined} data-side={drawer || results ? true : undefined} aria-label="Tadaima in-room panel">
    {/* ---------- top bar ---------- */}
    <header className="room-x__bar" data-xr-solid>
      <div className="room-x__start">
        <span className="room-x__pill room-x__home">
          {/* eslint-disable-next-line @next/next/no-img-element -- rasterized offscreen; next/image lazy-loading would miss the capture */}
          <img src={mark.src} alt="" className="room-x__mark" />
        </span>
      </div>
      <h1 className="room-x__title">{state.roomLabel || "Your room"}</h1>
      <div className="room-x__bar-end">
        {hit("tab-controls", "room-x__pill room-x__help", "?", () => toggle("controls"), { ariaLabel: "Controls", pressed: tab === "controls" })}
        {hit("tab-room", "room-x__pill", <span>Inventory{stored.length ? ` · ${stored.length}` : ""}</span>, () => toggle("room"), { ariaLabel: "Inventory", pressed: tab === "room" })}
        {hit("tab-basket", "room-x__pill room-x__basket-btn", <>{Icon.basket}<span className="room-x__basket-total">{basket.length ? state.basketTotal : "$0"}</span></>,
          () => toggle("basket"), { ariaLabel: `Basket, ${basket.length} pieces`, pressed: tab === "basket" })}
        {hit("close", "room-x__pill room-x__home", Icon.close, props.onClose, { ariaLabel: "Hide menu" })}
      </div>
    </header>

    {/* ---------- search results beside the room, as after a spoken search ---------- */}
    {results ? <aside className="room-x__results" aria-label="Search results" data-xr-solid>
      <div className="room-x__results-head"><strong>Matches for this spot</strong></div>
      <ol>
        {state.offers.slice(0, 4).map((offer, index) => <li key={offer.id} data-fits={offer.fits !== false || undefined}>
          <span className="room-x__results-n">{index + 1}</span>
          <div><p>{shortName(offer.label)}</p>
            <small>{offer.product?.price ? roomProductMoney(offer.product.price.amountMinor, offer.product.price.currency) : "Price unknown"} · {offer.fits === false ? offer.problems?.[0] ?? "doesn't fit" : offer.withinBudget === false ? "over budget" : "fits"}</small></div>
          {placeable(offer) ? hit(`preview:${offer.id}`, "room-x__chip-btn", "Add", () => props.onPreviewOffer(offer.id), { disabled: state.busy || offer.withinBudget === false || state.pendingOfferId === offer.id }) : null}
        </li>)}
      </ol>
    </aside> : null}

    {/* ---------- placement confirmation ---------- */}
    {pending ? <div className="room-x__placement" role="region" aria-label="Confirm furniture placement" data-xr-solid>
      <strong>{shortName(pending.label)}</strong>
      <p>{pending.product?.price ? roomProductMoney(pending.product.price.amountMinor, pending.product.price.currency) : "Price unknown"}{pending.fits === false ? ` · ${pending.problems?.[0] ?? "doesn't fit here"}` : ""}</p>
      <div>{action("cancel-preview", "room-x__chip-btn", "Cancel")}{hit("confirm", "room-x__chip-btn room-x__chip-btn--ink", "Add to room", props.onConfirmOffer, { disabled: !canConfirm })}</div>
    </div> : null}

    {/* ---------- selected piece: toolbar and details ---------- */}
    {selected && !pending ? <>
      <div className="room-x__toolbar" data-docked role="toolbar" aria-label={`Edit ${selected.label}`} data-xr-solid>
        <span className="room-x__toolbar-name">{shortName(selected.label)}</span>
        {action("rotate-selected", "room-x__tool", <>{Icon.rotate}<span className="room-x__key">R</span></>, "Rotate")}
        {action("store-selected", "room-x__tool", <>{Icon.close}<span className="room-x__key">Del</span></>, "Put away in inventory")}
      </div>
      <div className="room-x__carry room-x__info" role="status" data-xr-solid>
        <strong>{shortName(selected.label)}</strong>
        <span>{roomProductDimensions(selected.dimensions ?? null)}{selected.priceMinor != null && selected.currency ? ` · ${roomProductMoney(selected.priceMinor, selected.currency)}` : ""}{selected.locked ? " · Locked" : ""}</span>
      </div>
    </> : null}

    {/* ---------- bottom tools and hotbar ---------- */}
    <div className="room-x__bottom">
      <div className="room-x__tools" data-xr-solid>
        <div className="room-voice">
          {agent?.caption || agent?.activity || agent?.error ? <p className="room-voice__caption" data-error={agent.error ? true : undefined} role="status">{agent.error || agent.caption || agent.activity}</p> : null}
          {agent?.available ? <>
            <span className="room-voice__beam">{action("voice-toggle", "room-x__pill room-voice__btn", <>{agent.listening ? "Send" : "Talk"}<span className="room-voice__key" aria-hidden="true">hold A</span></>)}</span>
            {agent.connected || agent.listening ? action("voice-stop", "room-x__pill room-voice__mute", "End") : null}
          </> : <span className="room-x__pill room-voice__btn" aria-disabled="true">Voice unavailable</span>}
        </div>
        {hit("tab-shop", "room-x__pill room-x__pill--ink", <>{Icon.plus}<span>Add furniture</span></>, () => toggle("shop"), { pressed: tab === "shop" })}
      </div>
      <div className="room-x__hotbar" role="list" aria-label="Inventory" data-xr-solid>
        {Array.from({ length: HOTBAR_SLOTS }, (_, index) => {
          const item = stored[index];
          return item ? <span key={item.id} role="listitem">
            {action(`take-out:${item.id}`, "room-x__slot", <><CategoryGlyph category={item.category ?? "other"} /><span className="room-x__slot-n">{index + 1}</span></>, `Slot ${index + 1}: ${shortName(item.label)}. Bring back`, true)}
          </span> : <span key={`empty-${index}`} role="listitem" className="room-x__slot" aria-label={`Slot ${index + 1}: empty`}><span className="room-x__slot-n">{index + 1}</span></span>;
        })}
      </div>
    </div>

    {/* ---------- drawers: the website's catalog, basket and inventory panels ---------- */}
    {drawer === "shop" ? <div className="room-x__panel room-x__catalog" role="dialog" aria-label="Add furniture" data-open data-xr-solid>
      {head("Add furniture", "At your selected floor spot")}
      <div className="room-x__chips" role="group" aria-label="What kind of piece">
        {CATEGORIES.map(([id, label]) => <span key={id}>{hit(`action:search-${id}`, "room-x__chip", label, () => { setCategory(id); props.onAction(`search-${id}`); },
          { pressed: category === id, disabled: !enabled(`search-${id}`) || state.busy })}</span>)}
      </div>
      {state.status ? <p className="room-x__search-status" role="status">{state.status}</p> : null}
      {state.offers.length ? <ul className="room-x__products" data-xr-scroll>{state.offers.map(product)}</ul>
        : <p className="room-x__empty">Pick a kind of piece. Results that fit your floor spot appear here.</p>}
    </div> : null}

    {drawer === "basket" ? <div className="room-x__panel room-x__basket" role="dialog" aria-label="Basket" data-open data-xr-solid>
      {head("Basket")}
      {basket.length === 0 ? <p className="room-x__empty">Nothing yet. Pieces you add to the room land here.</p>
        : <ul className="room-x__lines" data-xr-scroll>{basket.map((item) => line(item, <>
          <p className="room-x__line-price">{roomProductMoney(item.priceMinor ?? null, item.currency ?? null)}</p>
          {action(`remove-item:${item.id}`, "room-x__text-btn", "Remove", `Remove ${item.label}`)}
        </>))}</ul>}
      <div className="room-x__basket-foot">
        <p className="room-x__total"><span>Total</span><span>{state.basketTotal || "$0.00"}</span></p>
        <p className="room-x__panel-sub">Check out on the website after you take the headset off. Nothing is ordered in VR.</p>
      </div>
    </div> : null}

    {drawer === "room" ? <div className="room-x__panel" role="dialog" aria-label="Inventory" data-open data-xr-solid>
      {head("Inventory")}
      {stored.length === 0 ? <p className="room-x__empty">Nothing put away.</p>
        : <ul className="room-x__lines" data-xr-scroll>{stored.map((item) => line(item, action(`take-out:${item.id}`, "room-x__text-btn", "Take out", `Take out ${item.label}`)))}</ul>}
    </div> : null}

    {drawer === "controls" ? <div className="room-x__panel" role="dialog" aria-label="Controls" data-open data-xr-solid>
      {head("Controls")}
      <ul className="room-x__lines" data-xr-scroll>
        {([
          ["Left stick", locomotion === "walk" ? "Walk where you’re facing" : "Aim at the floor, release to teleport"],
          ["Right stick", "Snap turn · scrolls a panel you point at"],
          ["Trigger", "Choose a piece or press a button"],
          ["A or X", "Hold to talk to Tadaima, release to send"],
          ["Left grip", "Bring this menu in front of you"],
          ["Right grip", "Hide or show this menu"],
        ] as const).map(([control, use]) => <li key={control} className="room-x__line">
          <div className="room-x__line-main"><p className="room-x__line-name">{control}</p><p className="room-x__line-dims">{use}</p></div>
        </li>)}
      </ul>
      <div className="room-x__basket-foot">
        {hit("locomotion", "room-x__chip-btn", locomotion === "walk" ? "Switch to teleport" : "Switch to walking", props.onLocomotionToggle, { disabled: state.busy })}
        {hit("exit", "room-x__chip-btn room-x__chip-btn--ink", "Exit VR", props.onExit)}
      </div>
    </div> : null}
  </div>;
}

/** Imperative renderer for the Three.js adapter; never moves focus or opens a microphone. */
export function mountXRPanel(host: HTMLElement, props: XRPanelProps) {
  const root = createRoot(host);
  let disposed = false;
  const update = (next: XRPanelProps) => { if (!disposed) root.render(<RoomXRPanel {...next} />); };
  update(props);
  // Unmounting inside a React render (an XR session ending mid-update) must wait for that render to finish.
  return { update, dispose() { if (disposed) return; disposed = true; queueMicrotask(() => root.unmount()); } };
}
