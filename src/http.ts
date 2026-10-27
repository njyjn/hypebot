import { ProxyAgent, fetch as proxiedFetch } from "undici";

// Apple serves a 404 page to obviously scripted clients, so look like Safari.
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

// Set from proxy_url: Apple requests go through it, never falling back to a direct connection.
let proxy: { url: string; agent: ProxyAgent } | undefined;

export function setProxy(url: string | undefined): void {
  proxy?.agent.close().catch(() => {});
  proxy = url ? { url, agent: new ProxyAgent(url) } : undefined;
}

/** The deepest error in a `.cause` chain (undici wraps proxy failures two levels down). */
function rootCause(error: unknown): { code?: unknown; message?: string } | undefined {
  let e = error as { cause?: unknown } | undefined;
  while (e && typeof e === "object" && e.cause) e = e.cause as { cause?: unknown };
  return e as { code?: unknown; message?: string } | undefined;
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
  const timedOut = new Error(`timed out after ${timeoutMs / 1000}s via proxy ${via.url}`);
  let timer: NodeJS.Timeout | undefined;
  // undici doesn't abort while it is still opening the proxy tunnel, so enforce the timeout here too.
  const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(timedOut), timeoutMs)));
  try {
    const res = await Promise.race([proxiedFetch(url, { ...init, dispatcher: via.agent }), deadline]);
    return { status: res.status, body: await Promise.race([res.text(), deadline]) };
  } catch (error) {
    if (error === timedOut) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw timedOut;
    // Before any response: the proxy (the VPN app) is the problem, not Apple.
    const root = rootCause(error);
    const answered = /Proxy response \((\d+)\)/.exec(root?.message ?? "")?.[1];
    if (answered) throw new Error(`proxy ${via.url} could not connect (proxy answered ${answered}; is the VPN connected?)`);
    const why = typeof root?.code === "string" ? root.code : (root?.message ?? (error instanceof Error ? error.message : String(error)));
    throw new Error(`proxy ${via.url} unreachable (${why})`);
  } finally {
    clearTimeout(timer);
  }
}
