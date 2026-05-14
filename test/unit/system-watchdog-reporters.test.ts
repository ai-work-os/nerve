import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatAlertLine,
  formatChannelMessage,
  appendAlertsToFile,
} from "../../src/plugins/system-watchdog/reporters.js";
import type { Alert } from "../../src/plugins/system-watchdog/evaluator.js";

describe("formatAlertLine", () => {
  it("格式：- HH:MM:SS  node  metric  detail", () => {
    const alert: Alert = { nodeName: "duty-monitor", metric: "idle", detail: "idle 180s > max 120s" };
    const line = formatAlertLine(alert, new Date("2026-05-14T02:13:00"));
    expect(line).toBe("- 02:13:00  duty-monitor  idle  idle 180s > max 120s");
  });
});

describe("formatChannelMessage", () => {
  it("0 alerts → 空串", () => {
    expect(formatChannelMessage([])).toBe("");
  });

  it("1 alert → 紧凑单行 + 详情指向", () => {
    const alerts: Alert[] = [
      { nodeName: "email-watcher", metric: "liveness", detail: "pid 123 not alive" },
    ];
    const msg = formatChannelMessage(alerts);
    expect(msg).toContain("system-watchdog");
    expect(msg).toContain("email-watcher");
    expect(msg).toContain("liveness");
    expect(msg).toContain("system-alerts.md");
  });

  it("多 alert → 多行", () => {
    const alerts: Alert[] = [
      { nodeName: "a", metric: "liveness", detail: "x" },
      { nodeName: "b", metric: "idle", detail: "y" },
    ];
    const msg = formatChannelMessage(alerts);
    expect(msg.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("appendAlertsToFile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
    file = join(dir, "system-alerts.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("第一次写：创建文件 + 写日期段头 + 行", () => {
    const alerts: Alert[] = [{ nodeName: "a", metric: "idle", detail: "x" }];
    appendAlertsToFile(file, alerts, new Date("2026-05-14T02:13:00"));
    expect(existsSync(file)).toBe(true);
    const c = readFileSync(file, "utf-8");
    expect(c).toContain("## 2026-05-14");
    expect(c).toContain("02:13:00  a  idle  x");
  });

  it("同日第二次：复用日期段，追加行", () => {
    appendAlertsToFile(file, [{ nodeName: "a", metric: "idle", detail: "x" }], new Date("2026-05-14T02:13:00"));
    appendAlertsToFile(file, [{ nodeName: "b", metric: "memory", detail: "y" }], new Date("2026-05-14T02:14:00"));
    const c = readFileSync(file, "utf-8");
    expect(c.match(/## 2026-05-14/g)?.length).toBe(1);
    expect(c).toContain("02:13:00  a  idle  x");
    expect(c).toContain("02:14:00  b  memory  y");
  });

  it("跨日：追加新日期段头", () => {
    appendAlertsToFile(file, [{ nodeName: "a", metric: "idle", detail: "x" }], new Date("2026-05-14T23:59:00"));
    appendAlertsToFile(file, [{ nodeName: "b", metric: "idle", detail: "y" }], new Date("2026-05-15T00:01:00"));
    const c = readFileSync(file, "utf-8");
    expect(c).toContain("## 2026-05-14");
    expect(c).toContain("## 2026-05-15");
  });

  it("空 alerts → 不写", () => {
    appendAlertsToFile(file, [], new Date("2026-05-14T02:13:00"));
    expect(existsSync(file)).toBe(false);
  });
});
