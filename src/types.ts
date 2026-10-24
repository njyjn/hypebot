// Shared shapes passed between sources, the watcher, notifiers and sensors.

/** One `watch` entry from the add-on settings. */
export interface WatchConfig {
  source: string; // which shop, e.g. "apple_sg"
  product: string; // slug in the shop URL, e.g. "iphone-duo"
  variants: string[]; // e.g. "Star White / 512GB"
}

/** A single resolved model being watched. */
export interface WatchItem {
  id: string; // stable, e.g. "apple_sg:MK2G4X/A"
  source: string;
  shop: string; // shown in alerts, e.g. "Apple SG"
  product: string;
  productName: string; // "iPhone Duo"
  variantName: string; // "Night Sky 512GB"
  partNumber: string;
  buyUrl: string; // this model's own page when the shop has one
  productUrl: string; // the product's page, for alerts covering several models
}

export interface StoreStock {
  name: string;
  quote: string; // the shop's own wording, e.g. "Available Today"
}

/** Stores that have an item right now. Empty `stores` means unavailable. */
export interface Availability {
  itemId: string;
  stores: StoreStock[];
}

export interface Source {
  name: string; // matches `source` in the watch settings, e.g. "apple_sg"
  label: string; // shown in alerts, e.g. "Apple SG"
  /** Turn settings into watch items. Throws if a name matches nothing. */
  resolve(entries: WatchConfig[]): Promise<WatchItem[]>;
  /** Current availability for every item passed in. Throws on any failure. */
  check(items: WatchItem[]): Promise<Availability[]>;
}

export interface AlertMessage {
  title: string;
  lines: string[];
  url?: string; // where tapping the alert goes
  links?: { label: string; url: string }[]; // one buy link per model when several restock at once
  urgent?: boolean; // stock alerts: delivered as loudly as the destination allows
}

export interface Notifier {
  name: string;
  /** Rejects if the destination did not accept the message. */
  send(msg: AlertMessage): Promise<void>;
}
