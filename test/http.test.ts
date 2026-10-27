import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchText, setProxy } from "../src/http.js";

const servers: Server[] = [];
afterEach(async () => {
  setProxy(undefined);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(s: Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

/** A plain HTTP target that records which paths it served. */
async function target() {
  const hits: string[] = [];
  const port = await listen(createServer((req, res) => (hits.push(req.url ?? ""), res.end("direct"))));
  return { port, hits };
}

/** A fake forward proxy: tunnels CONNECT to the target when `tunnel`, otherwise refuses with 502. */
async function fakeProxy(tunnel = false) {
  const seen: string[] = [];
  const s = createServer();
  s.on("connect", (req, socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    if (!tunnel) return void socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  const port = await listen(s);
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe("fetchText with a proxy", () => {
  it("sends requests through the proxy's tunnel", async () => {
    const t = await target();
    const p = await fakeProxy(true);
    setProxy(p.url);
    expect(await fetchText(`http://127.0.0.1:${t.port}/x`)).toEqual({ status: 200, body: "direct" });
    expect(p.seen).toEqual([`CONNECT 127.0.0.1:${t.port}`]); // reached the target only via the proxy
    expect(t.hits).toEqual(["/x"]);
  });

  it("tunnels https with CONNECT, and a refused tunnel names the proxy", async () => {
    const p = await fakeProxy(false);
    setProxy(p.url);
    await expect(fetchText("https://www.apple.com/sg/shop/x")).rejects.toThrow(/proxy http:\/\/127\.0\.0\.1:\d+ unreachable/);
    expect(p.seen).toEqual(["CONNECT www.apple.com:443"]);
  });

  it("says the proxy is unreachable when nothing listens there", async () => {
    setProxy("http://127.0.0.1:1");
    await expect(fetchText("http://127.0.0.1:2/x")).rejects.toThrow(/proxy http:\/\/127\.0\.0\.1:1 unreachable \(ECONNREFUSED\)/);
  });

  it("goes direct again once the proxy is cleared", async () => {
    const t = await target();
    setProxy("http://127.0.0.1:1");
    setProxy(undefined);
    expect(await fetchText(`http://127.0.0.1:${t.port}/y`)).toEqual({ status: 200, body: "direct" });
    expect(t.hits).toEqual(["/y"]);
  });
});
