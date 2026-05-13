import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOldAudio } from "../../src/plugins/ai-life-log/audio-cleaner.js";

function makeOpus(dir: string, name: string, daysAgo: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "x");
  const t = (Date.now() - daysAgo * 86400_000) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe("audio-cleaner", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifelog-clean-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("删除 mtime > 7 天的 .opus", () => {
    const fresh = makeOpus(join(dir, "2026-05-09"), "fresh.opus", 1);
    const old = makeOpus(join(dir, "2026-05-01"), "old.opus", 9);
    const stats = cleanOldAudio(dir, 7);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(stats.deleted).toBe(1);
  });

  it("递归清理 corrupt/ 与 failed/ 子目录", () => {
    const oldCorrupt = makeOpus(join(dir, "corrupt", "2026-04-01"), "x.opus", 30);
    const oldFailed = makeOpus(join(dir, "failed", "2026-04-01"), "y.opus", 30);
    const stats = cleanOldAudio(dir, 7);
    expect(existsSync(oldCorrupt)).toBe(false);
    expect(existsSync(oldFailed)).toBe(false);
    expect(stats.deleted).toBe(2);
  });

  it("audioDir 不存在不抛错", () => {
    const stats = cleanOldAudio(join(dir, "no-such-dir"), 7);
    expect(stats.deleted).toBe(0);
  });
});
