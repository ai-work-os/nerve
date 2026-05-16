import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { downloadBlob, fetchPendingMac, ackMac } from "../../src/plugins/mac-clipboard/blob-client.js";

describe("blob-client", () => {
  let server: Server;
  let base: string;
  let ackCalls: string[];

  beforeEach(async () => {
    ackCalls = [];
    server = createServer((req, res) => {
      const url = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && url === "/screenshot/blob/good") {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(Buffer.from("JPEG-BYTES"));
        return;
      }
      if (req.method === "GET" && url === "/screenshot/blob/missing") {
        res.writeHead(404); res.end(); return;
      }
      if (req.method === "GET" && url === "/screenshot/pending-mac") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ blobId: "p1", takenAtMs: 111, source: "phone" }]));
        return;
      }
      if (req.method === "POST" && url === "/screenshot/ack-mac") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
          ackCalls.push(JSON.parse(body).blobId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  it("downloadBlob 返回字节和 mimeType", async () => {
    const r = await downloadBlob(base, "good");
    expect(r).not.toBeNull();
    expect(r!.data).toEqual(Buffer.from("JPEG-BYTES"));
    expect(r!.mimeType).toBe("image/jpeg");
  });

  it("downloadBlob 404 返回 null", async () => {
    expect(await downloadBlob(base, "missing")).toBeNull();
  });

  it("fetchPendingMac 返回未投递列表", async () => {
    const list = await fetchPendingMac(base);
    expect(list).toEqual([{ blobId: "p1", takenAtMs: 111, source: "phone" }]);
  });

  it("ackMac POST blobId", async () => {
    await ackMac(base, "p1");
    expect(ackCalls).toEqual(["p1"]);
  });
});
