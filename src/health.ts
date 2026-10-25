import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Tracks how often a shop refuses or fails checks, so a partial block
// (Apple refusing some requests) is visible before it costs a restock.

export type HealthState = "ok" | "degraded" | "blocked";

export interface HealthSummary {
  state: HealthState;
  checks: number; // checks in the last hour
  failures: number; // failed checks in the last hour
  failureRate: number; // 0..1
  lastError?: string;
  lastSuccess?: number; // epoch ms
}

const WINDOW_MS = 60 * 60_000;
const DEGRADED_RATE = 0.3;
const DEGRADED_MIN_FAILURES = 5;
const BLOCKED_IN_A_ROW = 10;

/** What survives a restart: the last hour of checks plus alert state. */
export interface HealthSnapshot {
  events: { at: number; ok: boolean }[];
  lastError?: string;
  lastSuccess?: number;
  alerted: boolean;
}

export class HealthTracker {
  private events: { at: number; ok: boolean }[] = [];
  private lastError?: string;
  private lastSuccess?: number;
  private alerted = false;

  record(ok: boolean, at: number, error?: string): void {
    this.events.push({ at, ok });
    if (ok) this.lastSuccess = at;
    else if (error) this.lastError = error;
  }

  /** @param failuresInARow consecutive failed checks right now */
  summary(at: number, failuresInARow: number): HealthSummary {
    this.events = this.events.filter((e) => at - e.at < WINDOW_MS);
    const checks = this.events.length;
    const failures = this.events.filter((e) => !e.ok).length;
    const failureRate = checks === 0 ? 0 : failures / checks;
    const state: HealthState =
      failuresInARow >= BLOCKED_IN_A_ROW ? "blocked" : failures >= DEGRADED_MIN_FAILURES && failureRate > DEGRADED_RATE ? "degraded" : "ok";
    return { state, checks, failures, failureRate, lastError: this.lastError, lastSuccess: this.lastSuccess };
  }

  toJSON(): HealthSnapshot {
    return { events: this.events, lastError: this.lastError, lastSuccess: this.lastSuccess, alerted: this.alerted };
  }

  static fromJSON(data: unknown): HealthTracker {
    const h = new HealthTracker();
    if (!data || typeof data !== "object") return h;
    const d = data as Partial<HealthSnapshot>;
    if (Array.isArray(d.events)) h.events = d.events.filter((e) => typeof e?.at === "number" && typeof e?.ok === "boolean");
    if (typeof d.lastError === "string") h.lastError = d.lastError;
    if (typeof d.lastSuccess === "number") h.lastSuccess = d.lastSuccess;
    h.alerted = d.alerted === true;
    return h;
  }

  /** "degraded" the first time health leaves ok, "cleared" when it returns; otherwise null. */
  transition(s: HealthSummary): "degraded" | "cleared" | null {
    if (s.state !== "ok" && !this.alerted) {
      this.alerted = true;
      return "degraded";
    }
    if (s.state === "ok" && this.alerted) {
      this.alerted = false;
      return "cleared";
    }
    return null;
  }
}

/** Shop name -> tracker, read from the health file; empty when missing or unreadable. */
export function loadHealth(path: string): Record<string, HealthTracker> {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(data).map(([name, snap]) => [name, HealthTracker.fromJSON(snap)]));
  } catch {
    return {};
  }
}

export function saveHealth(path: string, trackers: Record<string, HealthTracker>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(trackers));
  renameSync(`${path}.tmp`, path);
}
