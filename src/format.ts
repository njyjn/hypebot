import type { AlertMessage, StoreStock, WatchItem } from "./types.js";
import type { Changes } from "./watcher.js";

function storeList(stores: StoreStock[]): string {
  const quotes = new Set(stores.map((s) => s.quote));
  if (quotes.size === 1) return `${stores.map((s) => s.name).join(", ")} (${stores[0].quote})`;
  return stores.map((s) => `${s.name} (${s.quote})`).join(", ");
}

const products = (items: WatchItem[]) => new Set(items.map((i) => `${i.source}:${i.product}`));

/** " (Apple SG)" when every item is from one shop, else nothing. */
function shopSuffix(items: WatchItem[]): string {
  const shops = new Set(items.map((i) => i.shop));
  return shops.size === 1 ? ` (${items[0].shop})` : "";
}

export function formatStockAlert(news: Changes["newlyInStock"]): AlertMessage {
  const items = news.map((n) => n.item);
  const single = products(items).size === 1;
  return {
    title: single ? `🟢 ${items[0].productName} in stock${shopSuffix(items)}` : `🟢 Stock alert${shopSuffix(items)}`,
    lines: news.map(({ item, stores }) => `${single ? "" : `${item.productName} `}${item.variantName}: ${storeList(stores)}`),
    ...(single ? { url: items[0].buyUrl } : {}),
  };
}

export function formatSoldOut(items: WatchItem[]): AlertMessage {
  const single = products(items).size === 1;
  return {
    title: single ? `⚪ ${items[0].productName} sold out${shopSuffix(items)}` : `⚪ Sold out${shopSuffix(items)}`,
    lines: items.map((i) => (single ? i.variantName : `${i.productName} ${i.variantName}`)),
  };
}

export function formatStatus(title: string, detail: string): AlertMessage {
  return { title, lines: [detail] };
}

/** Plain text body used by every destination. */
export function plainText(msg: AlertMessage): string {
  return [...msg.lines.map((l) => (msg.lines.length > 1 ? `• ${l}` : l)), ...(msg.url ? [`Buy: ${msg.url}`] : [])].join("\n");
}
