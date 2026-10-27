import { ProxyAgent, fetch as proxiedFetch } from "undici";

// Apple serves a 404 page to obviously scripted clients, so look like Safari.
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

// Set from proxy_url: Apple requests go through it, never falling back to a direct connection.
let proxy: { url: string; agent: ProxyAgent } | undefined;

export function setProxy(url: string | undefined): void {
  void proxy?.agent.close();
  proxy = url ? { url, agent: new ProxyAgent(url) } : undefined;
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  const init = {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (!proxy) {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.text() };
  }
  const via = proxy;
  try {
    const res = await proxiedFetch(url, { ...init, dispatcher: via.agent });
    return { status: res.status, body: await res.text() };
  } catch (error) {
    // A timeout is a timeout; anything else before a response means the proxy (the VPN) is the problem.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
    const cause = (error as { cause?: { code?: unknown; message?: string } }).cause;
    const why = typeof cause?.code === "string" ? cause.code : (cause?.message ?? (error instanceof Error ? error.message : String(error)));
    throw new Error(`proxy ${via.url} unreachable (${why})`);
  }
}
