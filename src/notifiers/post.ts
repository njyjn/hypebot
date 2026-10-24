/** POST JSON and return the parsed reply; throws on HTTP errors. */
export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
