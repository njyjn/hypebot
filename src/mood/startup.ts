export type ReadyCheck = { ok: true } | { ok: false; problem: string; permanent?: boolean };

const FAST_MS = 60_000;
const SLOW_MS = 30 * 60_000;
const GRACE_MS = 10 * 60_000; // Home Assistant can take a while to load integrations after a reboot

/**
 * Wait until the AI Task entity exists, then start mood. Runs in the
 * background: checks every minute for 10 minutes, then every 30 minutes,
 * and alerts once if it still isn't there after 10 minutes.
 */
export async function startMoodWhenReady(opts: {
  check: () => Promise<ReadyCheck>;
  start: () => void;
  alert: (title: string, detail: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let alerted = false;
  for (;;) {
    let r: ReadyCheck;
    try {
      r = await opts.check();
    } catch (error) {
      r = { ok: false, problem: `checking the AI Task failed (${error instanceof Error ? error.message : error})` };
    }
    if (r.ok) {
      if (alerted) await opts.alert("✅ HypeBot mood is on", "The AI Task is available now.");
      opts.start();
      return;
    }
    if (r.permanent || (!alerted && waited >= GRACE_MS)) {
      console.error(`Mood: ${r.problem}`);
      await opts.alert("⚠️ HypeBot mood is off", r.permanent ? r.problem : `${r.problem}. HypeBot keeps checking every 30 minutes.`);
      alerted = true;
      if (r.permanent) return;
    }
    const wait = waited < GRACE_MS ? FAST_MS : SLOW_MS;
    await sleep(wait);
    waited += wait;
  }
}
