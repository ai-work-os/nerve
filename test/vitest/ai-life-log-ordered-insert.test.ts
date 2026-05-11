import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";

describe("DailyFileWriter ordered insert", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifelog-ordered-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("尾部到达时直接 append（fast path）", () => {
    const w = new DailyFileWriter(dir);
    const day = (h: number, m: number, s: number) =>
      new Date(`2026-05-09T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}+08:00`);
    w.appendOrInsert("first", day(9, 0, 0), "mac");
    w.appendOrInsert("second", day(9, 0, 30), "mac");
    const f = join(dir, "2026-05-09.txt");
    expect(readFileSync(f, "utf8")).toBe("[09:00:00][mac] first\n[09:00:30][mac] second\n");
  });

  it("晚到的旧时间戳被插入到正确位置", () => {
    const w = new DailyFileWriter(dir);
    const day = (h: number, m: number, s: number) =>
      new Date(`2026-05-09T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}+08:00`);
    w.appendOrInsert("mac10", day(10, 0, 0), "mac");
    w.appendOrInsert("mac12", day(12, 0, 0), "mac");
    // 手机晚到，录音时间是 11:00（在 mac10 和 mac12 中间）
    w.appendOrInsert("phone11", day(11, 0, 0), "android-pixel8");
    const f = join(dir, "2026-05-09.txt");
    expect(readFileSync(f, "utf8")).toBe(
      "[10:00:00][mac] mac10\n[11:00:00][android-pixel8] phone11\n[12:00:00][mac] mac12\n"
    );
  });

  it("同毫秒时按 source 字典序稳定排序", () => {
    const w = new DailyFileWriter(dir);
    const t = new Date("2026-05-09T09:00:00+08:00");
    w.appendOrInsert("z", t, "mac");
    w.appendOrInsert("a", t, "android-pixel8");
    const f = join(dir, "2026-05-09.txt");
    // android-pixel8 < mac，所以 android 在前
    expect(readFileSync(f, "utf8")).toBe(
      "[09:00:00][android-pixel8] a\n[09:00:00][mac] z\n"
    );
  });
});
