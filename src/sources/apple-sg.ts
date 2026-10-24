import { fetchText } from "../http.js";
import type { Availability, Source, WatchConfig, WatchItem } from "../types.js";
import { COLOUR_ALIASES } from "./aliases.js";

const SHOP = "https://www.apple.com/sg/shop";

export interface CatalogueEntry {
  partNumber: string;
  colourCode: string; // "nightsky"
  colourName: string; // "Night Sky"
  capacity: string; // "512gb"
}

export interface Catalogue {
  productName: string;
  entries: CatalogueEntry[];
}

export const buyUrl = (product: string) => `${SHOP}/buy-iphone/${product}`;

/** Read the model list embedded in an Apple buy page. */
export function parseCatalogue(html: string): Catalogue {
  const title = /<title>\s*Buy (.+?) - Apple/i.exec(html)?.[1]?.trim() ?? "";

  const colourNames = new Map<string, string>();
  for (const m of html.matchAll(/"([a-z0-9]+)":\{"value":"([^"]+)"/g)) colourNames.set(m[1], m[2]);

  // Each product object starts with "partNumber" and carries its dimensions
  // later in the same object, before the next product starts.
  const starts = [...html.matchAll(/\{"partNumber":"([A-Z0-9]+\/A)"/g)];
  const entries = new Map<string, CatalogueEntry>();
  starts.forEach((m, i) => {
    const chunk = html.slice(m.index, starts[i + 1]?.index ?? html.length);
    const colour = /"dimensionColor":"([^"]+)"/.exec(chunk)?.[1];
    const capacity = /"dimensionCapacity":"([^"]+)"/.exec(chunk)?.[1];
    if (!colour || !capacity || entries.has(m[1])) return;
    entries.set(m[1], {
      partNumber: m[1],
      colourCode: colour,
      colourName: colourNames.get(colour) ?? colour,
      capacity: capacity.toLowerCase(),
    });
  });

  return { productName: title, entries: [...entries.values()] };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function variantLabel(e: CatalogueEntry): string {
  return `${e.colourName} ${e.capacity.toUpperCase()}`;
}

function optionLabel(e: CatalogueEntry): string {
  return `${e.colourName} / ${e.capacity.toUpperCase()}`;
}

/** "512", "512GB", "1 TB" -> "512gb" / "1tb". A bare number under 10 means TB. */
function parseCapacity(token: string): string | undefined {
  const m = /^(\d+)(gb|tb)?$/.exec(norm(token));
  if (!m) return undefined;
  const unit = m[2] ?? (Number(m[1]) < 10 ? "tb" : "gb");
  return `${m[1]}${unit}`;
}

function colourMatches(e: CatalogueEntry, token: string): boolean {
  const t = norm(token);
  return t === e.colourCode || t === norm(e.colourName) || (COLOUR_ALIASES[e.colourCode] ?? []).includes(t);
}

/** Find the single catalogue entry for "Colour / Capacity". */
export function matchVariant(cat: Catalogue, variant: string): CatalogueEntry {
  const parts = variant.split("/").map((p) => p.trim()).filter(Boolean);
  const capacity = parts.length === 2 ? parseCapacity(parts[1]) : undefined;
  const hits = capacity ? cat.entries.filter((e) => e.capacity === capacity && colourMatches(e, parts[0])) : [];
  if (hits.length === 1) return hits[0];

  const valid = cat.entries.map(optionLabel).join(", ");
  throw new Error(`"${variant}" does not match one ${cat.productName || "product"} model. Use "Colour / Capacity", one of: ${valid}`);
}

// Any Singapore postcode returns all three stores; this one is Orchard Road.
const POSTCODE = "238859";

export function pickupUrl(parts: string[]): string {
  const q = new URLSearchParams({ pl: "true", location: POSTCODE });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  return `${SHOP}/retail/pickup-message?${q}`;
}

interface PickupResponse {
  body?: {
    stores?: {
      storeName: string;
      partsAvailability?: Record<string, { pickupDisplay?: string; pickupSearchQuote?: string }>;
    }[];
  };
}

/**
 * Read a pickup-message response. Apple sometimes answers with an HTML
 * "Page Not Found" page when it refuses a request; that throws, so the
 * caller counts it as a failed check rather than "nothing in stock".
 */
export function parsePickup(body: string, items: WatchItem[], storeFilter: string[]): Availability[] {
  let data: PickupResponse;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Apple SG did not return stock data (got a web page instead)");
  }
  const stores = data.body?.stores;
  if (!Array.isArray(stores)) throw new Error("Apple SG stock data has no store list");

  const wanted = storeFilter.map((s) => s.trim().toLowerCase());
  const included = stores.filter((s) => wanted.length === 0 || wanted.includes(s.storeName.toLowerCase()));

  return items.map((item) => ({
    itemId: item.id,
    stores: included.flatMap((s) => {
      const a = s.partsAvailability?.[item.partNumber];
      return a?.pickupDisplay === "available" ? [{ name: s.storeName, quote: a.pickupSearchQuote ?? "Available" }] : [];
    }),
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Load a product's model list. Apple occasionally refuses a request with its
 * "Page Not Found" page, so try a few times before reporting a failure.
 */
async function loadCatalogue(product: string, attempts: number, retryDelayMs: number): Promise<Catalogue> {
  const url = buyUrl(product);
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retryDelayMs);
    const page = await fetchText(url);
    status = page.status;
    const cat = page.status === 200 ? parseCatalogue(page.body) : undefined;
    if (cat && cat.entries.length > 0) return cat;
  }
  throw new Error(`Could not read models for "${product}" from ${url} (HTTP ${status})`);
}

/** Store names Apple returned that a filter entry should match. */
function storeNames(body: string): string[] {
  const data = JSON.parse(body) as PickupResponse;
  return (data.body?.stores ?? []).map((s) => s.storeName);
}

export function createAppleSg(opts: { stores: string[]; retryDelayMs?: number }): Source {
  const retryDelayMs = opts.retryDelayMs ?? 5_000;
  let filterChecked = opts.stores.length === 0;

  return {
    name: "apple_sg",
    label: "Apple SG",

    async resolve(entries: WatchConfig[]): Promise<WatchItem[]> {
      const items = new Map<string, WatchItem>();
      for (const entry of entries) {
        const cat = await loadCatalogue(entry.product, 3, retryDelayMs);
        for (const variant of entry.variants) {
          const e = matchVariant(cat, variant);
          const id = `apple_sg:${e.partNumber}`;
          if (items.has(id)) continue;
          items.set(id, {
            id,
            source: "apple_sg",
            shop: "Apple SG",
            product: entry.product,
            productName: cat.productName,
            variantName: variantLabel(e),
            partNumber: e.partNumber,
            buyUrl: buyUrl(entry.product),
          });
        }
      }
      return [...items.values()];
    },

    async check(items: WatchItem[]): Promise<Availability[]> {
      const res = await fetchText(pickupUrl(items.map((i) => i.partNumber)));
      if (res.status !== 200) throw new Error(`Apple SG returned HTTP ${res.status}`);
      const result = parsePickup(res.body, items, opts.stores);

      // A typo in apple_sg_stores would otherwise silently mean "never in stock".
      if (!filterChecked) {
        filterChecked = true;
        const names = storeNames(res.body);
        const known = new Set(names.map((n) => n.toLowerCase()));
        const unknown = opts.stores.filter((s) => !known.has(s.trim().toLowerCase()));
        if (unknown.length > 0) {
          console.warn(`apple_sg_stores: ${unknown.map((s) => `"${s}"`).join(", ")} matches no store. Store names are: ${names.join(", ")}`);
        }
      }
      return result;
    },
  };
}
