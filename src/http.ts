// Apple serves a 404 page to obviously scripted clients, so look like Safari.
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export async function fetchText(url: string, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}
