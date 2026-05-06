import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";
import { AsrPipeline, int16ToFloat32 } from "../../src/plugins/ai-life-log/asr-pipeline.js";

describe("DailyFileWriter", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifelog-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("appends one formatted line for a single timestamp", () => {
    const w = new DailyFileWriter(dir);
    const ts = new Date("2026-05-06T09:14:05+08:00");
    w.append("早上好", ts);
    const expected = join(dir, "2026-05-06.txt");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf8")).toBe("[09:14:05] 早上好\n");
  });

  it("appends a second line in the same day to the same file", () => {
    const w = new DailyFileWriter(dir);
    const t1 = new Date("2026-05-06T09:14:05+08:00");
    const t2 = new Date("2026-05-06T09:14:32+08:00");
    w.append("第一句", t1);
    w.append("第二句", t2);
    const f = join(dir, "2026-05-06.txt");
    expect(readFileSync(f, "utf8")).toBe("[09:14:05] 第一句\n[09:14:32] 第二句\n");
  });

  it("rolls to a new file when the day changes", () => {
    const w = new DailyFileWriter(dir);
    w.append("昨夜", new Date("2026-05-06T23:59:50+08:00"));
    w.append("今晨", new Date("2026-05-07T00:00:10+08:00"));
    expect(readdirSync(dir).sort()).toEqual(["2026-05-06.txt", "2026-05-07.txt"]);
    expect(readFileSync(join(dir, "2026-05-06.txt"), "utf8")).toBe("[23:59:50] 昨夜\n");
    expect(readFileSync(join(dir, "2026-05-07.txt"), "utf8")).toBe("[00:00:10] 今晨\n");
  });

  it("preserves existing file content when re-instantiated mid-day", () => {
    const w1 = new DailyFileWriter(dir);
    w1.append("原有", new Date("2026-05-06T10:00:00+08:00"));
    const w2 = new DailyFileWriter(dir);
    w2.append("追加", new Date("2026-05-06T11:00:00+08:00"));
    const f = join(dir, "2026-05-06.txt");
    expect(readFileSync(f, "utf8")).toBe("[10:00:00] 原有\n[11:00:00] 追加\n");
  });

  it("creates the directory if missing", () => {
    const sub = join(dir, "nested", "log");
    const w = new DailyFileWriter(sub);
    w.append("hello", new Date("2026-05-06T10:00:00+08:00"));
    expect(existsSync(join(sub, "2026-05-06.txt"))).toBe(true);
  });

  it("strips embedded newlines from text to keep one-line-per-segment invariant", () => {
    const w = new DailyFileWriter(dir);
    w.append("第一行\n第二行", new Date("2026-05-06T10:00:00+08:00"));
    const f = join(dir, "2026-05-06.txt");
    expect(readFileSync(f, "utf8")).toBe("[10:00:00] 第一行 第二行\n");
  });

  it("counts written lines and characters via stats()", () => {
    const w = new DailyFileWriter(dir);
    w.append("hi", new Date("2026-05-06T10:00:00+08:00"));
    w.append("世界", new Date("2026-05-06T10:00:01+08:00"));
    const s = w.stats(new Date("2026-05-06T10:00:02+08:00"));
    expect(s.lines).toBe(2);
    expect(s.chars).toBe(4); // "hi"(2) + "世界"(2)
    expect(s.file.endsWith("2026-05-06.txt")).toBe(true);
  });

  it("ignores empty or whitespace-only text without creating a file", () => {
    const w = new DailyFileWriter(dir);
    const ts = new Date("2026-05-06T10:00:00+08:00");
    w.append("", ts);
    w.append("   ", ts);
    w.append("\n\t  ", ts);
    expect(readdirSync(dir).length).toBe(0);
  });
});

describe("int16ToFloat32", () => {
  it("converts little-endian int16 to normalized float32 in [-1, 1]", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(32767, 2);
    buf.writeInt16LE(-32768, 4);
    buf.writeInt16LE(16384, 6);
    const f = int16ToFloat32(buf);
    expect(f.length).toBe(4);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.999969, 4);
    expect(f[2]).toBe(-1);
    expect(f[3]).toBeCloseTo(0.5, 4);
  });

  it("returns empty array for empty buffer", () => {
    expect(int16ToFloat32(Buffer.alloc(0)).length).toBe(0);
  });

  it("ignores trailing odd byte", () => {
    const buf = Buffer.alloc(3);
    buf.writeInt16LE(100, 0);
    expect(int16ToFloat32(buf).length).toBe(1);
  });
});

// --- AsrPipeline with fake adapter ---

interface FakeSegment { samples: Float32Array; }

class FakeVad {
  private queue: FakeSegment[] = [];
  enqueue(seg: FakeSegment): void { this.queue.push(seg); }
  acceptWaveform(_samples: Float32Array): void { /* test triggers segments via enqueue() */ }
  isEmpty(): boolean { return this.queue.length === 0; }
  isDetected(): boolean { return this.queue.length > 0; }
  front(): FakeSegment { return this.queue[0]; }
  pop(): void { this.queue.shift(); }
  flush(): void { /* noop */ }
  reset(): void { this.queue = []; }
}

class FakeRecognizer {
  public lastSamples: Float32Array | null = null;
  public textForNext = "测试";
  createStream() {
    let captured: Float32Array | null = null;
    return {
      acceptWaveform: (obj: { samples: Float32Array; sampleRate: number }) => {
        captured = obj.samples;
        this.lastSamples = obj.samples;
      },
      _captured: () => captured,
    };
  }
  decode(_stream: unknown): void { /* noop */ }
  getResult(_stream: unknown): { text: string } { return { text: this.textForNext }; }
}

describe("AsrPipeline", () => {
  it("emits 'text' events with the recognizer's output and a timestamp", async () => {
    const vad = new FakeVad();
    const rec = new FakeRecognizer();
    const pipeline = new AsrPipeline({ vad: vad as any, recognizer: rec as any, sampleRate: 16000 });

    const events: { text: string; ts: Date }[] = [];
    pipeline.on("text", (text, ts) => events.push({ text, ts }));

    vad.enqueue({ samples: new Float32Array([0.1, 0.2, 0.3]) });
    pipeline.feed(Buffer.alloc(2)); // any PCM triggers the drain loop

    await new Promise(r => setImmediate(r));
    expect(events.length).toBe(1);
    expect(events[0].text).toBe("测试");
    expect(events[0].ts).toBeInstanceOf(Date);
  });

  it("drops empty/whitespace transcripts without emitting", async () => {
    const vad = new FakeVad();
    const rec = new FakeRecognizer();
    rec.textForNext = "   ";
    const pipeline = new AsrPipeline({ vad: vad as any, recognizer: rec as any, sampleRate: 16000 });

    const events: any[] = [];
    pipeline.on("text", (t) => events.push(t));

    vad.enqueue({ samples: new Float32Array([0.1, 0.2]) });
    pipeline.feed(Buffer.alloc(2));

    await new Promise(r => setImmediate(r));
    expect(events.length).toBe(0);
  });

  it("paused() pipeline does not feed VAD", () => {
    const vad = new FakeVad();
    const rec = new FakeRecognizer();
    let acceptedCount = 0;
    (vad as any).acceptWaveform = () => { acceptedCount++; };
    const pipeline = new AsrPipeline({ vad: vad as any, recognizer: rec as any, sampleRate: 16000 });

    pipeline.pause();
    pipeline.feed(Buffer.alloc(4));
    expect(acceptedCount).toBe(0);

    pipeline.resume();
    pipeline.feed(Buffer.alloc(4));
    expect(acceptedCount).toBe(1);
  });
});
