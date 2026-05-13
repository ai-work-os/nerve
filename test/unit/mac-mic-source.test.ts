/**
 * MacMicSource restart safety — verifies the restartCapture cycle waits for the
 * old AudioCapture to truly exit before spawning a new one. Without this, the
 * old Swift binary keeps holding the mic while a new one starts, leaking
 * processes (observed 2026-05-11: 9 stale AudioCapture children stacked up).
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { MacMicSource } from "../../src/plugins/ai-life-log/sources/mac-mic-source.js";

interface FakeCapture extends EventEmitter {
  start: () => Promise<void>;
  stop: () => void;
  stopAndWait: (timeoutMs?: number) => Promise<void>;
  readonly running: boolean;
}

describe("MacMicSource restart safety", () => {
  it("stop() 走 stopAndWait（不是裸 stop），保证旧子进程真死", async () => {
    const events: string[] = [];
    const factory = (): FakeCapture => {
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { events.push("start"); };
      (cap as any).stop = () => { events.push("stop"); };
      (cap as any).stopAndWait = async () => { events.push("stopAndWait"); };
      Object.defineProperty(cap, "running", { get: () => false });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    expect(events).toEqual(["start"]);
    await src.stop();
    expect(events).toContain("stopAndWait");
    expect(events).not.toContain("stop");
  });

  it("restartCapture：旧 capture 的 stopAndWait 完成后才 spawn 新", async () => {
    const order: string[] = [];
    let releaseStopAndWait: (() => void) | null = null;
    let count = 0;
    const factory = (): FakeCapture => {
      count++;
      const id = count;
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { order.push(`start-${id}`); };
      (cap as any).stop = () => { order.push(`stop-${id}`); };
      (cap as any).stopAndWait = async () => {
        order.push(`stopAndWait-${id}-begin`);
        await new Promise<void>(r => { releaseStopAndWait = r; });
        order.push(`stopAndWait-${id}-end`);
      };
      Object.defineProperty(cap, "running", { get: () => false });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    expect(order).toEqual(["start-1"]);

    const restart = (src as any).restartCapture("test");

    // 等几个 tick 让 restartCapture 进入 stopAndWait
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    expect(order).toEqual(["start-1", "stopAndWait-1-begin"]);
    expect(count).toBe(1); // 还没 spawn 第二个

    releaseStopAndWait!();
    await restart;

    expect(order).toEqual([
      "start-1",
      "stopAndWait-1-begin",
      "stopAndWait-1-end",
      "start-2",
    ]);
  });

  it("默认 captureFactory 在非 darwin 抛错（保护真实 mac binary 调用）", async () => {
    if (process.platform === "darwin") return; // 此 case 仅在非 darwin 验证
    const src = new MacMicSource();
    await expect(src.start(() => {})).rejects.toThrow(/darwin|macOS/);
  });

  it("watchdog: 120s drift 不触发 restart（短卡顿容忍）", async () => {
    const events: string[] = [];
    const factory = (): FakeCapture => {
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { events.push("start"); };
      (cap as any).stop = () => { events.push("stop"); };
      (cap as any).stopAndWait = async () => { events.push("stopAndWait"); };
      Object.defineProperty(cap, "running", { get: () => true });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    // 模拟 lastTick 距今 30s + 120s drift = 150s 前
    (src as any).lastTick = Date.now() - 150_000;
    (src as any).running = true;
    (src as any).wakeTick();
    expect(events).toEqual(["start"]); // 没有 stopAndWait / 没有新 start
    await src.stop();
  });

  it("watchdog: 360s drift 触发 restart（真正长休眠）", async () => {
    const events: string[] = [];
    const factory = (): FakeCapture => {
      const cap = new EventEmitter() as FakeCapture;
      (cap as any).start = async () => { events.push("start"); };
      (cap as any).stop = () => { events.push("stop"); };
      (cap as any).stopAndWait = async () => { events.push("stopAndWait"); };
      Object.defineProperty(cap, "running", { get: () => true });
      return cap;
    };
    const src = new MacMicSource({ captureFactory: factory });
    await src.start(() => {});
    (src as any).lastTick = Date.now() - 390_000; // 30s tick + 360s drift
    (src as any).running = true;
    (src as any).wakeTick();
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    expect(events).toContain("stopAndWait");
    expect(events.filter(e => e === "start").length).toBeGreaterThanOrEqual(2);
    await src.stop();
  });
});
