import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Item id -> names of stores that had it at the last successful check. */
export type StockState = Record<string, string[]>;

export function loadState(path: string): StockState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    console.warn(`State file ${path} is unreadable; starting fresh`);
    return {};
  }
}

/** Write via a temp file so a crash mid-write cannot leave half a file. */
export function saveState(path: string, state: StockState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
