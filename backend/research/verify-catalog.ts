/**
 * Spot-check real-catalog.json against the live product pages with a plain
 * HTTP fetch (no agent). Checks price from the page's JSON-LD Offer and, for
 * IKEA, the measurement rows. Prints a report; `--drop` removes products whose
 * price or dimensions disagree with the page or could not be checked.
 *
 *   npx tsx backend/research/verify-catalog.ts [--drop]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Evidence, ProductCandidate } from "@/backend/contracts";

const FILE = path.join(process.cwd(), "backend/fixtures/real-catalog.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const TOLERANCE_M = 0.015;

const FRACTIONS: Record<string, string> = {
  "\u00bc": "1/4",
  "\u00bd": "1/2",
  "\u00be": "3/4",
  "\u215b": "1/8",
  "\u215c": "3/8",
  "\u215d": "5/8",
  "\u215e": "7/8",
};

/** Parse IKEA US values like `28 3/4 "`, `6 ' 5 "`, `71 cm`. Returns meters. */
function parseLength(raw: string): number | null {
  const s = raw
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[\u00bc\u00bd\u00be\u215b\u215c\u215d\u215e]/g, (c) => ` ${FRACTIONS[c]}`)
    .trim();
  const cm = s.match(/^([\d.]+)\s*cm$/);
  if (cm) return Number(cm[1]) / 100;
  const num = (t: string) => t.trim().split(/\s+/).reduce((acc, part) => {
    const f = part.match(/^(\d+)\/(\d+)$/);
    return acc + (f ? Number(f[1]) / Number(f[2]) : Number(part));
  }, 0);
  const ftIn = s.match(/^(?:([\d\s/]+)')?\s*(?:([\d\s/]+)")?$/);
  if (!ftIn || (!ftIn[1] && !ftIn[2])) return null;
  const inches = (ftIn[1] ? num(ftIn[1]) * 12 : 0) + (ftIn[2] ? num(ftIn[2]) : 0);
  return Number.isFinite(inches) && inches > 0 ? inches * 0.0254 : null;
}

function ikeaMeasurements(html: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /measurement-name">([^<]+)<\/span><span class="[^"]*measurement-value">([^<]+)</g;
  for (const m of html.matchAll(re)) {
    const name = m[1].trim().toLowerCase();
    const v = parseLength(m[2]);
    if (v !== null && !out.has(name)) out.set(name, v);
  }
  return out;
}

function offerPrice(html: string): number | null {
  const m = html.match(/"@type":"Offer"[^}]*?"price":"?([\d.]+)"?/);
  return m ? Number(m[1]) : null;
}

const close = (a: number, candidates: Array<number | undefined>) => candidates.some((c) => c !== undefined && Math.abs(a - c) <= TOLERANCE_M);

const TARGET_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"; // public web key embedded in target.com pages
const UNIT_M: Record<string, number> = { inches: 0.0254, inch: 0.0254, feet: 0.3048, foot: 0.3048, centimeters: 0.01, millimeters: 0.001 };

/** Target renders price client side, so read its public product API instead of the html. */
async function checkTarget(p: ProductCandidate): Promise<string[]> {
  const u = new URL(p.sourceUrl);
  const tcin = u.searchParams.get("preselect") ?? u.pathname.match(/A-(\d+)/)?.[1];
  if (!tcin) return ["no tcin in url"];
  const api = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=${TARGET_KEY}&tcin=${tcin}&pricing_store_id=3991&channel=WEB`;
  const res = await fetch(api, { headers: { "User-Agent": UA } });
  if (!res.ok) return [`redsky HTTP ${res.status}`];
  const product = ((await res.json()) as { data?: { product?: Record<string, unknown> } }).data?.product as
    | { price?: { current_retail?: number; current_retail_min?: number }; item?: { product_description?: { bullet_descriptions?: string[] } } }
    | undefined;
  if (!product) return ["redsky: no product"];
  const problems: string[] = [];
  const price = product.price?.current_retail ?? product.price?.current_retail_min;
  if (price === undefined) problems.push("no price");
  else if (!p.price || Math.abs(price * 100 - p.price.amountMinor) > 1) problems.push(`price api $${price} vs catalog ${p.price ? `$${p.price.amountMinor / 100}` : "null"}`);
  const dimLine = product.item?.product_description?.bullet_descriptions?.find((b) => b.includes("Dimensions (Overall)"));
  if (p.dimensions) {
    if (!dimLine) problems.push("no overall dimensions");
    else {
      const got: Record<string, number> = {};
      for (const m of dimLine.matchAll(/([\d.]+)\s+([A-Za-z]+)\s+\(([HWDL])\)/g)) got[m[3]] = Number(m[1]) * (UNIT_M[m[2].toLowerCase()] ?? NaN);
      const [w, h, d] = p.dimensions;
      if (!close(w, [got.W, got.L, got.D])) problems.push(`width ${w} vs ${dimLine}`);
      if (!close(d, [got.D, got.L, got.W])) problems.push(`depth ${d} vs ${dimLine}`);
      if (got.H !== undefined && !close(h, [got.H])) problems.push(`height ${h} vs ${dimLine}`);
    }
  }
  return problems;
}

async function check(p: ProductCandidate, ev: Evidence | undefined): Promise<string[]> {
  if (p.merchant === "Target") return checkTarget(p);
  const problems: string[] = [];
  const res = await fetch(p.sourceUrl, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  if (!res.ok) return [`HTTP ${res.status}`];
  const html = await res.text();
  const price = offerPrice(html);
  if (price === null) problems.push("no JSON-LD price on page");
  else if (!p.price || Math.abs(price * 100 - p.price.amountMinor) > 1) problems.push(`price page $${price} vs catalog ${p.price ? `$${p.price.amountMinor / 100}` : "null"}`);

  if (p.merchant === "IKEA" && p.dimensions) {
    const m = ikeaMeasurements(html);
    if (m.size === 0) problems.push("no measurements on page");
    else {
      const [w, h, d] = p.dimensions;
      const diam = [m.get("diameter"), m.get("shade diameter"), m.get("base diameter"), m.get("max. diameter")];
      if (!close(w, [m.get("width"), m.get("length"), ...diam])) problems.push(`width ${w} not on page ${JSON.stringify([...m])}`);
      if (!close(d, [m.get("depth"), m.get("length"), m.get("width"), ...diam])) problems.push(`depth ${d} not on page ${JSON.stringify([...m])}`);
      if (ev?.dimensionStatus !== "inferred" && !close(h, [m.get("height"), m.get("height including back cushions"), m.get("max. height"), m.get("thickness")])) problems.push(`height ${h} not on page ${JSON.stringify([...m])}`);
    }
  }
  return problems;
}

async function main() {
  const drop = process.argv.includes("--drop");
  const catalog = JSON.parse(readFileSync(FILE, "utf8")) as { products: ProductCandidate[]; evidence: Evidence[] };
  const evById = new Map(catalog.evidence.map((e) => [e.id, e]));
  const bad = new Set<string>();
  await Promise.all(
    catalog.products.map(async (p) => {
      const problems = await check(p, evById.get(p.evidenceIds[0])).catch((e: Error) => [`fetch failed: ${e.message}`]);
      console.log(`${problems.length ? "FAIL" : "ok  "} ${p.merchant} ${p.label}${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`);
      if (problems.length) bad.add(p.id);
    }),
  );
  console.log(`${catalog.products.length - bad.size}/${catalog.products.length} verified`);
  if (drop && bad.size) {
    const products = catalog.products.filter((p) => !bad.has(p.id));
    const keep = new Set(products.flatMap((p) => p.evidenceIds));
    writeFileSync(FILE, JSON.stringify({ ...catalog, products, evidence: catalog.evidence.filter((e) => keep.has(e.id)) }, null, 2) + "\n");
    console.log(`dropped ${bad.size}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
