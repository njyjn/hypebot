import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { WatchItem } from "../src/types.js";

export interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}

/** A local HTTP server that records requests and answers with `reply`. */
export async function fakeServer(reply: (req: Captured) => { status?: number; body?: unknown } = () => ({})) {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const captured: Captured = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(captured);
      const r = reply(captured);
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body ?? { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const duoItem = (partNumber: string, variantName: string, product = "iphone-duo", productName = "iPhone Duo"): WatchItem => ({
  id: `apple_sg:${partNumber}`,
  source: "apple_sg",
  shop: "Apple SG",
  product,
  productName,
  variantName,
  partNumber,
  buyUrl: `https://www.apple.com/sg/shop/buy-iphone/${product}`,
  productUrl: `https://www.apple.com/sg/shop/buy-iphone/${product}`,
});
