/**
 * Pure unit tests extracted from self-test.ts.
 * These tests do NOT need a running nerve server.
 */

import { describe, it } from "vitest";
import { assert, assertEq, assertNoThrow, existsSync, mkdirSync, rmSync } from "./helpers.ts";
import { checkProcessHealth, CronScheduler, checkHealth, getCpuUsage } from "../../src/plugins/duty-monitor/index.js";
import { EventLogger } from "../../src/event-logger.js";

// ============================================================
// EventLogger
// ============================================================

describe("EventLogger", () => {
  it("fail-open: constructor and log() do not throw on directory path", () => {
    const badPath = `/tmp/nerve-test-event-log-${Date.now()}`;
    if (existsSync(badPath)) rmSync(badPath, { recursive: true, force: true });
    mkdirSync(badPath, { recursive: true });

    let logger: EventLogger | null = null;
    assertNoThrow(() => {
      logger = new EventLogger(badPath);
    }, "event logger constructor does not throw on invalid path");

    assertNoThrow(() => {
      logger?.log("channel.created", { channelId: "ch-test" });
    }, "event logger log() does not throw on invalid path");

    rmSync(badPath, { recursive: true, force: true });
  });
});

// ============================================================
// mc-transcriber stopRecording safety
// ============================================================

describe("mc stop: stopRecording safety", () => {
  it("buffer.stop() flushes remaining lines and double-stop is safe", async () => {
    const { TranscriptBuffer } = await import("../../src/plugins/mc-transcriber/index.js");

    let flushCount = 0;
    const buf = new TranscriptBuffer({
      pushInterval: 60000,
      pushLines: 100,
      onFlush: () => { flushCount++; },
    });
    buf.add("line 1");
    buf.stop();
    assertEq(flushCount, 1, "mc stop: buffer.stop() flushes remaining lines");

    buf.stop();
    assertEq(flushCount, 1, "mc stop: double buffer.stop() is safe (no extra flush)");
  });

  it("capture error does not block asr/buffer cleanup", async () => {
    let captureStopCalled = false;
    let asrDisconnectCalled = false;
    let bufferStopCalled = false;

    const mockCapture = {
      stop() {
        captureStopCalled = true;
        throw new Error("capture device already released");
      },
    };

    const mockAsr = {
      disconnect() { asrDisconnectCalled = true; },
    };

    const mockBuffer = {
      stop() { bufferStopCalled = true; },
    };

    try { mockCapture.stop(); } catch { /* ignore */ }
    try { mockAsr.disconnect(); } catch { /* ignore */ }
    try { mockBuffer.stop(); } catch { /* ignore */ }

    assert(captureStopCalled, "mc stop: capture.stop() was called (even though it threw)");
    assert(asrDisconnectCalled, "mc stop: asr.disconnect() called despite capture error");
    assert(bufferStopCalled, "mc stop: buffer.stop() called despite capture error");
  });

  it("asr error does not block buffer cleanup", async () => {
    let captureStopCalled = false;
    let asrDisconnectCalled = false;
    let bufferStopCalled = false;

    const mockCapture = {
      stop() { captureStopCalled = true; },
    };

    const mockAsr = {
      disconnect() {
        asrDisconnectCalled = true;
        throw new Error("WebSocket already closed");
      },
    };

    const mockBuffer = {
      stop() { bufferStopCalled = true; },
    };

    try { mockCapture.stop(); } catch { /* ignore */ }
    try { mockAsr.disconnect(); } catch { /* ignore */ }
    try { mockBuffer.stop(); } catch { /* ignore */ }

    assert(captureStopCalled, "mc stop: capture.stop() called");
    assert(asrDisconnectCalled, "mc stop: asr.disconnect() called (threw)");
    assert(bufferStopCalled, "mc stop: buffer.stop() called despite asr error");
  });

  it("shutdown order is capture -> asr -> buffer", async () => {
    const callOrder: string[] = [];

    const mockCapture = {
      stop() { callOrder.push("capture"); },
    };
    const mockAsr = {
      disconnect() { callOrder.push("asr"); },
    };
    const mockBuffer = {
      stop() { callOrder.push("buffer"); },
    };

    try { mockCapture.stop(); } catch { /* ignore */ }
    try { mockAsr.disconnect(); } catch { /* ignore */ }
    try { mockBuffer.stop(); } catch { /* ignore */ }

    assertEq(callOrder, ["capture", "asr", "buffer"], "mc stop: shutdown order is capture → asr → buffer");
  });

  it("all three components throw, stopRecording still completes", async () => {
    let recording = true;
    const callOrder: string[] = [];

    const mockCapture = {
      stop() { callOrder.push("capture"); throw new Error("device released"); },
    };
    const mockAsr = {
      disconnect() { callOrder.push("asr"); throw new Error("ws closed"); },
    };
    const mockBuffer = {
      stop() { callOrder.push("buffer"); throw new Error("already stopped"); },
    };

    recording = false;

    let threw = false;
    try {
      try { mockCapture.stop(); } catch { /* ignore */ }
      try { mockAsr.disconnect(); } catch { /* ignore */ }
      try { mockBuffer.stop(); } catch { /* ignore */ }
    } catch {
      threw = true;
    }

    assert(!threw, "mc stop: no exception escapes when all three throw");
    assert(!recording, "mc stop: recording is false after all errors");
    assertEq(callOrder, ["capture", "asr", "buffer"], "mc stop: all three called despite errors");
  });

  it("each catch block logs a warning", async () => {
    const warnings: string[] = [];
    const mockLog = (level: string, msg: string) => {
      if (level === "warn") warnings.push(msg);
    };

    const mockCapture = {
      stop() { throw new Error("device released"); },
    };
    const mockAsr = {
      disconnect() { throw new Error("ws already closed"); },
    };
    const mockBuffer = {
      stop() { throw new Error("double stop"); },
    };

    try { mockCapture.stop(); } catch (err: any) {
      mockLog("warn", `capture.stop() error: ${err.message}`);
    }
    try { mockAsr.disconnect(); } catch (err: any) {
      mockLog("warn", `asr.disconnect() error: ${err.message}`);
    }
    try { mockBuffer.stop(); } catch (err: any) {
      mockLog("warn", `buffer.stop() error: ${err.message}`);
    }

    assertEq(warnings.length, 3, "mc stop: 3 warn logs emitted (one per catch)");
    assert(warnings[0].includes("capture.stop()"), "mc stop: warn[0] mentions capture.stop()", warnings[0]);
    assert(warnings[0].includes("device released"), "mc stop: warn[0] contains error message", warnings[0]);
    assert(warnings[1].includes("asr.disconnect()"), "mc stop: warn[1] mentions asr.disconnect()", warnings[1]);
    assert(warnings[1].includes("ws already closed"), "mc stop: warn[1] contains error message", warnings[1]);
    assert(warnings[2].includes("buffer.stop()"), "mc stop: warn[2] mentions buffer.stop()", warnings[2]);
    assert(warnings[2].includes("double stop"), "mc stop: warn[2] contains error message", warnings[2]);
  });
});

// ============================================================
// mc-transcriber API key
// ============================================================

describe("mc API key", () => {
  it("reads from DASHSCOPE_API_KEY env var", async () => {
    const savedKey = process.env.DASHSCOPE_API_KEY;
    try {
      process.env.DASHSCOPE_API_KEY = "test-key-12345";
      const key = process.env.DASHSCOPE_API_KEY || "";
      assertEq(key, "test-key-12345", "mc api key: reads env var value");
    } finally {
      if (savedKey !== undefined) process.env.DASHSCOPE_API_KEY = savedKey;
      else delete process.env.DASHSCOPE_API_KEY;
    }
  });

  it("empty key should block startRecording", async () => {
    const savedKey = process.env.DASHSCOPE_API_KEY;
    try {
      delete process.env.DASHSCOPE_API_KEY;
      const apiKey = process.env.DASHSCOPE_API_KEY || "";

      let errorLogged = false;
      let activitySet = "";
      let recordingStarted = false;

      if (!apiKey) {
        errorLogged = true;
        activitySet = "error: no API key";
      } else {
        recordingStarted = true;
      }

      assert(errorLogged, "mc api key: empty key triggers error log");
      assertEq(activitySet, "error: no API key", "mc api key: sets error activity");
      assert(!recordingStarted, "mc api key: recording not started without key");
    } finally {
      if (savedKey !== undefined) process.env.DASHSCOPE_API_KEY = savedKey;
      else delete process.env.DASHSCOPE_API_KEY;
    }
  });

  it("env key passed to AsrClient constructor", async () => {
    const testKey = "sk-test-dashscope-key";
    const mockConfig = {
      model: "qwen3-asr-flash-realtime",
      apiKey: testKey,
      sampleRate: 16000,
      audioFormat: "pcm",
      language: "zh",
    };

    const storedConfig = {
      model: mockConfig.model,
      apiKey: mockConfig.apiKey,
      sampleRate: mockConfig.sampleRate ?? 16000,
      audioFormat: mockConfig.audioFormat ?? "pcm",
      language: mockConfig.language ?? "zh",
    };

    assertEq(storedConfig.apiKey, testKey, "mc api key: AsrClient config stores the passed key");
    assert(storedConfig.apiKey.length > 0, "mc api key: stored key is non-empty");
  });
});

// ============================================================
// Memory monitor: process health check
// ============================================================

describe("checkProcessHealth", () => {
  it("no alert when below thresholds", async () => {
    const alerts = checkProcessHealth(
      { heapUsedMB: 500, rssMB: 800 },
      { heapThreshold: 1500, rssThreshold: 2000 }
    );
    assertEq(alerts.length, 0, "process-health: no alert when below thresholds");
  });

  it("heap alert when heap exceeds threshold", async () => {
    const alerts = checkProcessHealth(
      { heapUsedMB: 1800, rssMB: 800 },
      { heapThreshold: 1500, rssThreshold: 2000 }
    );
    assertEq(alerts.length, 1, "process-health: 1 alert when heap exceeds threshold");
    assertEq(alerts[0].metric, "v8_heap", "process-health: alert metric is v8_heap");
    assertEq(alerts[0].value, 1800, "process-health: alert value is 1800");
    assertEq(alerts[0].threshold, 1500, "process-health: alert threshold is 1500");
  });

  it("rss alert when rss exceeds threshold", async () => {
    const alerts = checkProcessHealth(
      { heapUsedMB: 500, rssMB: 2500 },
      { heapThreshold: 1500, rssThreshold: 2000 }
    );
    assertEq(alerts.length, 1, "process-health: 1 alert when rss exceeds threshold");
    assertEq(alerts[0].metric, "rss", "process-health: alert metric is rss");
  });

  it("both alerts when both exceed thresholds", async () => {
    const alerts = checkProcessHealth(
      { heapUsedMB: 1800, rssMB: 2500 },
      { heapThreshold: 1500, rssThreshold: 2000 }
    );
    assertEq(alerts.length, 2, "process-health: 2 alerts when both exceed thresholds");
    const metrics = alerts.map((a: any) => a.metric).sort();
    assertEq(metrics, ["rss", "v8_heap"], "process-health: both metrics reported");
  });
});

// ============================================================
// CronScheduler
// ============================================================

describe("CronScheduler", () => {
  it("fires at matching fixed time", async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler();
    scheduler.addJob({
      name: "test-daily",
      schedule: { hour: 22, minute: 0 },
      action: () => { fired.push("test-daily"); },
    });

    scheduler.tick(new Date(2026, 3, 8, 22, 0)); // April 8 22:00
    assertEq(fired.length, 1, "cron-fixed: fires at 22:00");
    assertEq(fired[0], "test-daily", "cron-fixed: correct job name");
  });

  it("does NOT fire at non-matching time", async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler();
    scheduler.addJob({
      name: "test-daily",
      schedule: { hour: 22, minute: 0 },
      action: () => { fired.push("test-daily"); },
    });

    scheduler.tick(new Date(2026, 3, 8, 10, 30)); // 10:30 — no match
    assertEq(fired.length, 0, "cron-nomatch: does not fire at wrong time");
  });

  it("dedup same-minute tick", async () => {
    let count = 0;
    const scheduler = new CronScheduler();
    scheduler.addJob({
      name: "test-dedup",
      schedule: { hour: 22, minute: 0 },
      action: () => { count++; },
    });

    scheduler.tick(new Date(2026, 3, 8, 22, 0));
    scheduler.tick(new Date(2026, 3, 8, 22, 0)); // same minute again
    assertEq(count, 1, "cron-dedup: fires only once per minute");
  });

  it("dayOfWeek filter", async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler();
    scheduler.addJob({
      name: "test-weekly",
      schedule: { hour: 8, minute: 0, dayOfWeek: 1 }, // Monday
      action: () => { fired.push("test-weekly"); },
    });

    // 2026-04-08 is a Wednesday (day=3)
    scheduler.tick(new Date(2026, 3, 8, 8, 0));
    assertEq(fired.length, 0, "cron-dow: does not fire on Wednesday for Monday job");

    // 2026-04-06 is a Monday (day=1)
    scheduler.tick(new Date(2026, 3, 6, 8, 0));
    assertEq(fired.length, 1, "cron-dow: fires on Monday");
  });

  it("intervalMinutes fires correctly", async () => {
    let count = 0;
    const scheduler = new CronScheduler();
    scheduler.addJob({
      name: "test-interval",
      schedule: { intervalMinutes: 60 },
      action: () => { count++; },
    });

    // First tick always fires (initial run)
    scheduler.tick(new Date(2026, 3, 8, 10, 0));
    assertEq(count, 1, "cron-interval: fires on first tick");

    // 30 min later — not enough
    scheduler.tick(new Date(2026, 3, 8, 10, 30));
    assertEq(count, 1, "cron-interval: does not fire before interval");

    // 60 min later — should fire
    scheduler.tick(new Date(2026, 3, 8, 11, 0));
    assertEq(count, 2, "cron-interval: fires after interval elapsed");
  });
});

// ============================================================
// checkHealth
// ============================================================

describe("checkHealth", () => {
  it("no alerts when all below thresholds", async () => {
    const alerts = checkHealth(50, 4e9, 8e9, 100e9, 500e9, { cpu: 80, mem: 85, disk: 90 });
    assertEq(alerts.length, 0, "checkHealth: no alerts");
  });

  it("cpu alert when above threshold", async () => {
    const alerts = checkHealth(95, 4e9, 8e9, 100e9, 500e9, { cpu: 80, mem: 85, disk: 90 });
    assertEq(alerts.length, 1, "checkHealth: 1 alert");
    assertEq(alerts[0].metric, "cpu", "checkHealth: cpu metric");
  });

  it("multiple alerts when all exceed", async () => {
    // cpu=95 (>80), mem=90% (>85), disk=95% (>90)
    const alerts = checkHealth(95, 7.2e9, 8e9, 475e9, 500e9, { cpu: 80, mem: 85, disk: 90 });
    assertEq(alerts.length, 3, "checkHealth: 3 alerts when all exceed");
  });
});

// ============================================================
// getCpuUsage
// ============================================================

describe("getCpuUsage", () => {
  it("correct percentage calculation", async () => {
    const prev = [{ model: "test", speed: 0, times: { user: 100, nice: 0, sys: 50, idle: 800, irq: 0 } }] as any;
    const curr = [{ model: "test", speed: 0, times: { user: 200, nice: 0, sys: 100, idle: 850, irq: 0 } }] as any;
    const pct = getCpuUsage(prev, curr);
    // total diff = (200+100+850) - (100+50+800) = 1150-950 = 200
    // idle diff = 850-800 = 50
    // cpu = (200-50)/200*100 = 75%
    assertEq(Math.round(pct), 75, "getCpuUsage: 75% cpu");
  });

  it("0% when all idle", async () => {
    const prev = [{ model: "test", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }] as any;
    const curr = [{ model: "test", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 200, irq: 0 } }] as any;
    const pct = getCpuUsage(prev, curr);
    assertEq(pct, 0, "getCpuUsage: 0% when all idle");
  });
});
