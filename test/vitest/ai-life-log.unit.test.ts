import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";

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
});
