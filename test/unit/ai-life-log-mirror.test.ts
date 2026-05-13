/**
 * DailyFileWriter mirror — appendOrInsert broadcasts to multiple directories
 * so a copy lands in ~/.ai/workspace/activity/life-log/ that auto-syncs to home.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyFileWriter } from "../../src/plugins/ai-life-log/daily-file-writer.js";

describe("DailyFileWriter mirror dirs", () => {
  let primary: string;
  let mirror: string;
  beforeEach(() => {
    primary = mkdtempSync(join(tmpdir(), "lifelog-primary-"));
    mirror = mkdtempSync(join(tmpdir(), "lifelog-mirror-"));
  });
  afterEach(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  });

  const ts = (h: number, m: number, s: number) =>
    new Date(`2026-05-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}+08:00`);

  it("数组传入两个目录时，每次写入都同时落到两边", () => {
    const w = new DailyFileWriter([primary, mirror]);
    w.appendOrInsert("hello", ts(9, 0, 0), "mac");
    w.appendOrInsert("world", ts(9, 0, 5), "mac");

    const expected = "[09:00:00][mac] hello\n[09:00:05][mac] world\n";
    expect(readFileSync(join(primary, "2026-05-13.txt"), "utf8")).toBe(expected);
    expect(readFileSync(join(mirror, "2026-05-13.txt"), "utf8")).toBe(expected);
  });

  it("镜像目录不存在时构造期自动创建", () => {
    const newPrimary = join(primary, "nested-primary");
    const newMirror = join(mirror, "nested-mirror");
    new DailyFileWriter([newPrimary, newMirror]);
    expect(existsSync(newPrimary)).toBe(true);
    expect(existsSync(newMirror)).toBe(true);
  });

  it("乱序插入也镜像（晚到的旧时间戳被插入正确位置）", () => {
    const w = new DailyFileWriter([primary, mirror]);
    w.appendOrInsert("t10", ts(10, 0, 0), "mac");
    w.appendOrInsert("t12", ts(12, 0, 0), "mac");
    w.appendOrInsert("t11", ts(11, 0, 0), "android");

    const expected =
      "[10:00:00][mac] t10\n[11:00:00][android] t11\n[12:00:00][mac] t12\n";
    expect(readFileSync(join(primary, "2026-05-13.txt"), "utf8")).toBe(expected);
    expect(readFileSync(join(mirror, "2026-05-13.txt"), "utf8")).toBe(expected);
  });

  it("单 string 入参向后兼容（旧用法不报错）", () => {
    const w = new DailyFileWriter(primary);
    w.appendOrInsert("solo", ts(8, 0, 0), "mac");
    expect(readFileSync(join(primary, "2026-05-13.txt"), "utf8"))
      .toBe("[08:00:00][mac] solo\n");
  });

  it("stats() 返回 primary 目录的统计（不是 mirror）", () => {
    const w = new DailyFileWriter([primary, mirror]);
    w.appendOrInsert("count me", ts(9, 0, 0), "mac");
    const s = w.stats(ts(9, 0, 1));
    expect(s.file).toBe(join(primary, "2026-05-13.txt"));
    expect(s.lines).toBe(1);
    expect(s.chars).toBe("count me".length);
  });
});
