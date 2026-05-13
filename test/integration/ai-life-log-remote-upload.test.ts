import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeLogHttpServer } from "../../src/plugins/ai-life-log/http-server.js";

async function postOpus(port: number, fileBytes: Buffer, meta: Record<string, any>, headers: Record<string, string> = {}) {
  const boundary = "----test" + Math.random().toString(36).slice(2);
  const head = (name: string, value: string, contentType?: string, filename?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"` +
    (filename ? `; filename="${filename}"` : "") +
    (contentType ? `\r\nContent-Type: ${contentType}` : "") +
    `\r\n\r\n`;
  const parts = [
    Buffer.from(head("meta", "")),
    Buffer.from(JSON.stringify(meta)),
    Buffer.from("\r\n"),
    Buffer.from(head("file", "", "audio/ogg", "chunk.opus")),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(parts);
  const res = await fetch(`http://127.0.0.1:${port}/plugins/ai-life-log/upload`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...headers },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("LifeLogHttpServer upload", () => {
  let dir: string;
  let srv: LifeLogHttpServer;
  let port: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lifelog-http-"));
    srv = new LifeLogHttpServer({
      port: 0, // 0 = OS pick free port (test isolation per feedback_integration_test_isolation)
      audioDir: join(dir, "audio"),
      onChunk: async () => {},
    });
    port = await srv.start();
  });
  afterEach(async () => {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("接收 multipart 上传并落盘 audio/{date}/{chunkId}.opus", async () => {
    const fileBytes = Buffer.from("FAKEOPUSBYTES");
    const recordedAt = new Date("2026-05-09T14:30:00+08:00").getTime();
    const r = await postOpus(port, fileBytes, {
      deviceId: "pixel8",
      recordedAtMs: recordedAt,
      durationMs: 60000,
      chunkId: "abc123",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.chunkId).toBe("abc123");
    const expectedPath = join(dir, "audio", "2026-05-09", "abc123.opus");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath)).toEqual(fileBytes);
  });

  it("缺 meta 字段返回 400", async () => {
    const r = await postOpus(port, Buffer.from("x"), {} as any);
    expect(r.status).toBe(400);
  });

  it("同 chunkId 二次上传返回 ok 但不再触发 onChunk (幂等)", async () => {
    let onChunkCalls = 0;
    await srv.stop();
    srv = new LifeLogHttpServer({
      port: 0,
      audioDir: join(dir, "audio2"),
      onChunk: async () => { onChunkCalls++; },
    });
    port = await srv.start();
    const meta = { deviceId: "p", recordedAtMs: 1700000000000, durationMs: 60000, chunkId: "dup1" };
    const r1 = await postOpus(port, Buffer.from("first"), meta);
    expect(r1.status).toBe(200);
    const r2 = await postOpus(port, Buffer.from("second"), meta);
    expect(r2.status).toBe(200);
    expect(r2.body.ok).toBe(true);
    // wait a tick for async onChunk dispatch
    await new Promise(r => setTimeout(r, 50));
    expect(onChunkCalls).toBe(1);
  });
});

describe("LifeLogHttpServer auth", () => {
  let dir: string; let srv: LifeLogHttpServer; let port: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lifelog-http-auth-"));
    srv = new LifeLogHttpServer({
      port: 0, audioDir: join(dir, "audio"),
      onChunk: async () => {},
      authToken: "secret123",
    });
    port = await srv.start();
  });
  afterEach(async () => { await srv.stop(); rmSync(dir, { recursive: true, force: true }); });

  it("缺 token 返回 401", async () => {
    const r = await postOpus(port, Buffer.from("x"), {
      deviceId: "p", recordedAtMs: 1, durationMs: 60000, chunkId: "c1",
    });
    expect(r.status).toBe(401);
  });

  it("错 token 返回 401", async () => {
    const r = await postOpus(port, Buffer.from("x"), {
      deviceId: "p", recordedAtMs: 1, durationMs: 60000, chunkId: "c1",
    }, { "X-LifeLog-Token": "wrong" });
    expect(r.status).toBe(401);
  });

  it("正确 token 返回 200", async () => {
    const r = await postOpus(port, Buffer.from("x"), {
      deviceId: "p", recordedAtMs: 1, durationMs: 60000, chunkId: "c2",
    }, { "X-LifeLog-Token": "secret123" });
    expect(r.status).toBe(200);
  });
});
