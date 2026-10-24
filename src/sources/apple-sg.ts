import { fetchText } from "../http.js";
import type { Availability, DeliveryDate, Source, WatchConfig, WatchItem } from "../types.js";
import { COLOUR_ALIASES } from "./aliases.js";

const PUBLIC_BASE = "https://www.apple.com/sg";
const SHOP = `${PUBLIC_BASE}/shop`;

export interface CatalogueEntry {
  partNumber: string;
  colourCode: string; // "nightsky"
  colourName: string; // "Night Sky"
  capacity: string; // "512gb"
  slug?: string; // the model's own page, e.g. "7.6-inch-display-512gb-night-sky"
}

export interface Catalogue {
  productName: string;
  entries: CatalogueEntry[];
}

export const buyUrl = (product: string) => `${SHOP}/buy-iphone/${product}`;

/** Read the model list embedded in an Apple buy page. */
export function parseCatalogue(html: string): Catalogue {
  const title = (/<title>\s*Buy (.+?) - Apple/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();

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

  // Each model has its own page, e.g. .../iphone-duo/7.6-inch-display-512gb-night-sky.
  // Match it by the capacity and colour at the end of the slug.
  const slugs = [...new Set([...html.matchAll(/\/buy-iphone\/[a-z0-9-]+\/([a-z0-9.-]+)"/g)].map((m) => m[1]))];
  const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const e of entries.values()) {
    e.slug = slugs.find((s) => s.endsWith(`-${e.capacity}-${kebab(e.colourName)}`));
  }

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

export function deliveryUrl(parts: string[]): string {
  const q = new URLSearchParams();
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  q.set("mt", "regular");
  return `${SHOP}/delivery-message?${q}`;
}

interface DeliveryResponse {
  body?: {
    content?: {
      deliveryMessage?: Record<string, { regular?: { deliveryOptionMessages?: { encodedUpperDateString?: string }[]; deliveryOptions?: { date?: string }[] } }>;
    };
  };
}

/** Read the standard-shipping delivery date per model from a delivery-message response. */
export function parseDelivery(body: string, items: WatchItem[]): Map<string, DeliveryDate> {
  let data: DeliveryResponse;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Apple SG did not return delivery data (got a web page instead)");
  }
  const messages = data.body?.content?.deliveryMessage;
  if (!messages) throw new Error("Apple SG delivery data has no delivery messages");

  const dates = new Map<string, DeliveryDate>();
  for (const item of items) {
    const regular = messages[item.partNumber]?.regular;
    // e.g. "20270125", or a range "20270118-20270125": keep the latest date promised
    const upper = regular?.deliveryOptionMessages?.[0]?.encodedUpperDateString?.match(/(\d{8})$/)?.[1];
    if (!upper) continue;
    dates.set(item.id, {
      date: `${upper.slice(0, 4)}-${upper.slice(4, 6)}-${upper.slice(6, 8)}`,
      label: regular?.deliveryOptions?.[0]?.date ?? upper,
    });
  }
  return dates;
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

export function createAppleSg(opts: { stores: string[]; retryDelayMs?: number; buyLinkBase?: string }): Source {
  const retryDelayMs = opts.retryDelayMs ?? 5_000;
  // Links in alerts can point at another Apple store front (e.g. an EPP store);
  // stock and model data always come from the public store.
  const linkBase = (opts.buyLinkBase || PUBLIC_BASE).replace(/\/+$/, "");
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
            buyUrl: `${linkBase}/shop/buy-iphone/${entry.product}${e.slug ? `/${e.slug}` : ""}`,
            productUrl: `${linkBase}/shop/buy-iphone/${entry.product}`,
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

    async deliveryDates(items: WatchItem[]): Promise<Map<string, DeliveryDate>> {
      const res = await fetchText(deliveryUrl(items.map((i) => i.partNumber)));
      if (res.status !== 200) throw new Error(`Apple SG returned HTTP ${res.status}`);
      return parseDelivery(res.body, items);
    },
  };
}
