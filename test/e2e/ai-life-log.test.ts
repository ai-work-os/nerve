import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";
import { RemoteUploadSource } from "../../src/plugins/ai-life-log/sources/remote-upload-source.js";

async function postOpus(port: number, fileBytes: Buffer, meta: Record<string, any>) {
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
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("ai-life-log e2e: mac + remote 并发", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifelog-e2e-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("mac 实时 + remote 晚到 → 同一日志按时间排序", async () => {
    const writer = new DailyFileWriter(join(dir, "log"));
    const pipeline = { recognizeChunk: (_pcm: Buffer) => "from phone" };
    const src = new RemoteUploadSource({ port: 0, audioDir: join(dir, "audio"), pipeline });
    src.on("text", (text: string, tsMs: number, tag: string) => writer.appendOrInsert(text, new Date(tsMs), tag));
    const port = await src.start();

    // mac 在 14:00 / 16:00 已经写了
    writer.appendOrInsert("mac at 14", new Date("2026-05-09T14:00:00+08:00"), "mac");
    writer.appendOrInsert("mac at 16", new Date("2026-05-09T16:00:00+08:00"), "mac");

    // 手机上传 15:00 录的 chunk（晚到）
    const fixture = readFileSync(join(__dirname, "../fixtures/lifelog/1s_16k_mono.opus"));
    const r = await postOpus(port, fixture, {
      deviceId: "pixel8",
      recordedAtMs: new Date("2026-05-09T15:00:00+08:00").getTime(),
      durationMs: 1000,
      chunkId: "phone15",
    });
    expect(r.status).toBe(200);
    await new Promise(r => setTimeout(r, 300));

    const logFile = join(dir, "log", "2026-05-09.txt");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toBe(
      "[14:00:00][mac] mac at 14\n" +
      "[15:00:00][android-pixel8] from phone\n" +
      "[16:00:00][mac] mac at 16\n"
    );
    await src.stop();
  });
});
