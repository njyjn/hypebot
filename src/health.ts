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
