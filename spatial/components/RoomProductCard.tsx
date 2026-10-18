"use client";

import { useLayoutEffect, useState } from "react";
import type { ProductCandidate, ShopResult, Vector3Meters } from "../../backend/contracts";
import "./RoomProductCard.css";

export type RoomProductCardProps = {
  product: ProductCandidate;
  fits?: boolean;
  withinBudget?: boolean | null;
  problems?: readonly string[];
  source?: ShopResult["source"];
  fitLabel?: string;
  actionLabel?: string;
  disabled?: boolean;
  canPreview?: boolean;
  onPreview?(): void;
  /** The same button is clicked by the WebXR DOM adapter. */
  xrId?: string;
  hovered?: boolean;
  linkToSource?: boolean;
  rasterizable?: boolean;
  onLayout?(): void;
};

export function roomProductMoney(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor == null || amountMinor < 0 || !currency) return "Price unknown";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100); }
  catch { return "Price unknown"; }
}
export function roomProductDimensions(dimensions: Vector3Meters | null | undefined): string {
  if (!dimensions || dimensions.length !== 3 || !dimensions.every((axis) => Number.isFinite(axis) && axis > 0)) return "Size not listed";
  const [width, height, depth] = dimensions.map((axis) => Math.round(axis * 100));
  return `${width} × ${depth} × ${height} cm`;
}
/** Only the known merchant image paths use the bounded server image proxy. */
export function roomProductImageUrl(url: string | null | undefined, rasterizable = false): string | undefined {
  if (!url) return undefined;
  if (/^\/(?!\/)/.test(url)) return url;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
  const proxyable = parsed.protocol === "https:" && !parsed.port && (
    (parsed.hostname === "www.ikea.com" && parsed.pathname.startsWith("/us/en/images/products/"))
    || (parsed.hostname === "target.scene7.com" && parsed.pathname.startsWith("/is/image/Target/"))
  );
  return rasterizable && proxyable ? `/api/product-image?url=${encodeURIComponent(parsed.href)}` : url;
}

/** Shared product content for the website catalog and its immersive DOM panel. */
export function RoomProductCard({ product, fits, withinBudget, problems, source, fitLabel, actionLabel = "Add to room",
  disabled = false, canPreview, onPreview, xrId, hovered, linkToSource = true, rasterizable = false, onLayout }: RoomProductCardProps) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = roomProductImageUrl(product.imageUrl, rasterizable);
  const hasImage = Boolean(image && failedImage !== image);
  const known = Boolean(product.dimensions);
  const previewable = canPreview ?? Boolean(fits && known && product.price && product.availability !== "unavailable");
  const fit = fitLabel ?? (product.availability === "unavailable" ? "Out of stock" : fits === false ? problems?.[0] ?? "Doesn’t fit here"
    : withinBudget === false ? "Fits · over budget" : fits ? "Fits here" : "Fit not checked");
  const sourceLabel = source === "live" ? "Live research" : source === "catalog" ? "Saved catalog" : product.merchant;
  useLayoutEffect(() => { onLayout?.(); });
  return <li className="room-product-card" data-unknown={!known || undefined}>
    <div className="room-product-card__image" data-has-image={hasImage || undefined}>
      {hasImage ? (
        // Merchant images are intentionally plain img elements; no Next remote host configuration is needed.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" loading={rasterizable ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer"
          crossOrigin={rasterizable ? "anonymous" : undefined} onLoad={onLayout} onError={() => { setFailedImage(image ?? null); }} />
      ) : <span className="room-product-card__no-image">Image unavailable</span>}
    </div>
    <div className="room-product-card__body">
      <p className="room-product-card__source">{product.merchant}{sourceLabel && sourceLabel !== product.merchant ? ` · ${sourceLabel}` : ""}</p>
      <p className="room-product-card__name">{linkToSource && /^https:\/\//i.test(product.sourceUrl)
        ? <a href={product.sourceUrl} target="_blank" rel="noreferrer">{product.label.split(",")[0]}</a>
        : product.label.split(",")[0]}</p>
      <p className="room-product-card__meta"><span>{roomProductDimensions(product.dimensions)}</span>
        <strong>{roomProductMoney(product.price?.amountMinor, product.price?.currency)}</strong></p>
      <p className="room-product-card__fit" data-ok={fits && withinBudget !== false || undefined}>{fit}</p>
      {onPreview && previewable ? <button type="button" className="room-product-card__action" onClick={onPreview}
        disabled={disabled} tabIndex={xrId ? -1 : undefined} data-xr-id={xrId} data-xr-hover={hovered || undefined}>{actionLabel}</button> : null}
    </div>
  </li>;
}
