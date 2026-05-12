import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteUploadSource } from "../../src/plugins/ai-life-log/sources/remote-upload-source.js";
import { AsrPipeline } from "../../src/plugins/ai-life-log/asr-pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fakePipeline(recognizeReturn: string | (() => string)): AsrPipeline {
  const get = typeof recognizeReturn === "function" ? recognizeReturn : () => recognizeReturn;
  return {
    recognizeChunk: (_pcm: Buffer) => get(),
  } as unknown as AsrPipeline;
}

async function postOpus(port: number, fileBytes: Buffer, meta: Record<string, any>, headers: Record<string, string> = {}) {
  const boundary = "----t" + Math.random().toString(36).slice(2);
  const part = (n: string, ct?: string, fn?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${n}"` +
    (fn ? `; filename="${fn}"` : "") + (ct ? `\r\nContent-Type: ${ct}` : "") + `\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(part("meta")), Buffer.from(JSON.stringify(meta)), Buffer.from("\r\n"),
    Buffer.from(part("file", "audio/ogg", "c.opus")), fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`http://127.0.0.1:${port}/plugins/ai-life-log/upload`, {
    method: "POST", body,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...headers },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("RemoteUploadSource", () => {
  let dir: string; let src: RemoteUploadSource | null = null; let port = 0;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifelog-rsrc-")); });
  afterEach(async () => { await src?.stop(); src = null; rmSync(dir, { recursive: true, force: true }); });

  it("有效 opus chunk → emit text 带 sourceTag=android-{deviceId} + ts=recordedAtMs", async () => {
    const events: Array<{ text: string; ts: number; tag: string }> = [];
    const pipeline = fakePipeline("hello world");
    src = new RemoteUploadSource({ port: 0, audioDir: join(dir, "audio"), pipeline });
    src.on("text", (text, tsMs, tag) => events.push({ text, ts: tsMs, tag }));
    port = await src.start();
    const fixture = readFileSync(join(__dirname, "../fixtures/lifelog/1s_16k_mono.opus"));
    const recordedAt = new Date("2026-05-09T14:30:00+08:00").getTime();
    const r = await postOpus(port, fixture, {
      deviceId: "pixel8", recordedAtMs: recordedAt, durationMs: 1000, chunkId: "ok1",
    });
    expect(r.status).toBe(200);
    await new Promise(r => setTimeout(r, 200));
    expect(events.length).toBe(1);
    expect(events[0].text).toBe("hello world");
    expect(events[0].ts).toBe(recordedAt);
    expect(events[0].tag).toBe("android-pixel8");
  });

  it("损坏 opus 搬 corrupt/{date}/，不 emit text", async () => {
    const events: any[] = [];
    const pipeline = fakePipeline(() => { throw new Error("should not be called"); });
    src = new RemoteUploadSource({ port: 0, audioDir: join(dir, "audio"), pipeline });
    src.on("text", (...args) => events.push(args));
    port = await src.start();
    const recordedAt = new Date("2026-05-09T14:30:00+08:00").getTime();
    await postOpus(port, Buffer.from("not-a-real-opus"), {
      deviceId: "p", recordedAtMs: recordedAt, durationMs: 1000, chunkId: "bad1",
    });
    await new Promise(r => setTimeout(r, 200));
    expect(events.length).toBe(0);
    expect(existsSync(join(dir, "audio", "corrupt", "2026-05-09", "bad1.opus"))).toBe(true);
  });

  it("recognizeChunk 抛错搬 failed/", async () => {
    const events: any[] = [];
    const pipeline = fakePipeline(() => { throw new Error("recognizer crash"); });
    src = new RemoteUploadSource({ port: 0, audioDir: join(dir, "audio"), pipeline });
    src.on("text", (...args) => events.push(args));
    port = await src.start();
    const fixture = readFileSync(join(__dirname, "../fixtures/lifelog/1s_16k_mono.opus"));
    const recordedAt = new Date("2026-05-09T14:30:00+08:00").getTime();
    await postOpus(port, fixture, {
      deviceId: "p", recordedAtMs: recordedAt, durationMs: 1000, chunkId: "fail1",
    });
    await new Promise(r => setTimeout(r, 200));
    expect(events.length).toBe(0);
    expect(existsSync(join(dir, "audio", "failed", "2026-05-09", "fail1.opus"))).toBe(true);
  });
});
