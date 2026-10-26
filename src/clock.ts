/** Local date (YYYY-MM-DD) and minutes past midnight in a time zone (default: the container's TZ). */
export function localClock(t: number, timeZone?: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const DAILY_WINDOW_MIN = 10; // a daily message missed by more than this is skipped

/** Is it time for today's daily message, and has it not gone out yet? */
export function dailyDue(now: number, time: string, lastSentDate: string | undefined, timeZone?: string): string | undefined {
  const { date, minutes } = localClock(now, timeZone);
  const [h, m] = time.split(":").map(Number);
  const due = h * 60 + m;
  return lastSentDate === date || minutes < due || minutes >= due + DAILY_WINDOW_MIN ? undefined : date;
}
