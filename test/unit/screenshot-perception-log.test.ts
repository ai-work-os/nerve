import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPerceptionLog } from "../../src/plugins/screenshot/perception-log.js";
import type { ScreenshotRecord } from "../../src/plugins/screenshot/screenshot-index.js";

function rec(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    blobId: "a".repeat(64),
    source: "phone",
    takenAtMs: new Date("2026-05-16T10:00:00+08:00").getTime(),
    receivedAtMs: new Date("2026-05-16T10:00:01+08:00").getTime(),
    analyze: true,
    deliveredToMac: false,
    ...overrides,
  };
}

describe("appendPerceptionLog", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ss-log-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("写到 receivedAtMs 对应日期的 YYYY-MM-DD.txt 并返回路径", () => {
    const path = appendPerceptionLog(dir, rec());
    expect(path).toBe(join(dir, "2026-05-16.txt"));
    expect(existsSync(path)).toBe(true);
  });

  it("每条记录写一行，含 source / blobId / analyze", () => {
    const path = appendPerceptionLog(dir, rec({ source: "pixel8" }));
    const line = readFileSync(path, "utf8").trim();
    expect(line).toContain("pixel8");
    expect(line).toContain("a".repeat(64));
    expect(line).toContain("analyze=true");
  });

  it("追加而非覆盖", () => {
    appendPerceptionLog(dir, rec({ blobId: "a".repeat(64) }));
    const path = appendPerceptionLog(dir, rec({ blobId: "b".repeat(64) }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
