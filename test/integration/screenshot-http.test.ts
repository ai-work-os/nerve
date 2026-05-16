import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScreenshotHttpServer } from "../../src/plugins/screenshot/http-server.js";

describe("ScreenshotHttpServer", () => {
  let srv: ScreenshotHttpServer;
  let port: number;
  let uploaded: { data: Buffer; source: string; analyze: boolean; takenAtMs: number }[];
  let blobs: Map<string, Buffer>;
  let acked: string[];

  beforeEach(async () => {
    uploaded = [];
    acked = [];
    blobs = new Map([["abc", Buffer.from("STORED-IMAGE")]]);
    srv = new ScreenshotHttpServer({
      port: 0,
      maxBytes: 1024,
      onUpload: (data, meta) => {
        uploaded.push({ data, ...meta });
        return "newblobid";
      },
      getBlob: (id) => blobs.get(id) ?? null,
      listPendingMac: () => [{ blobId: "p1", takenAtMs: 1, source: "phone" }],
      onAckMac: (id) => { acked.push(id); return true; },
    });
    port = await srv.start();
  });
  afterEach(async () => { await srv.stop(); });

  it("POST /screenshot/upload 接收 raw 图片 + header 元数据，返回 blobId", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Source": "pixel8",
        "X-Analyze": "true",
        "X-Taken-At": "1747000000000",
      },
      body: Buffer.from("PNG-DATA"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).blobId).toBe("newblobid");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].data).toEqual(Buffer.from("PNG-DATA"));
    expect(uploaded[0].source).toBe("pixel8");
    expect(uploaded[0].analyze).toBe(true);
    expect(uploaded[0].takenAtMs).toBe(1747000000000);
  });

  it("缺 X-Source 时 source 落为 unknown，仍 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/upload`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from("x"),
    });
    expect(res.status).toBe(200);
    expect(uploaded[0].source).toBe("unknown");
    expect(uploaded[0].analyze).toBe(false);
  });

  it("body 超过 maxBytes 返回 413", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/upload`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.alloc(2048),
    });
    expect(res.status).toBe(413);
    expect(uploaded).toHaveLength(0);
  });

  it("GET /screenshot/blob/:id 返回原字节", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/blob/abc`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from("STORED-IMAGE"));
  });

  it("GET /screenshot/blob/:id 不存在返回 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/blob/nope`);
    expect(res.status).toBe(404);
  });

  it("GET /screenshot/pending-mac 返回未投递列表", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/pending-mac`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ blobId: "p1", takenAtMs: 1, source: "phone" }]);
  });

  it("POST /screenshot/ack-mac 标记投递", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/screenshot/ack-mac`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobId: "p1" }),
    });
    expect(res.status).toBe(200);
    expect(acked).toEqual(["p1"]);
  });

  it("未知路径返回 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
