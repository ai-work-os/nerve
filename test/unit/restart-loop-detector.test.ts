/**
 * restart-loop-detector — pure logic: given per-service restart timestamps,
 * decide which services are in a "restart loop" (≥ threshold restarts within
 * a rolling window). No I/O, no state — fully deterministic given `now`.
 */
import { describe, it, expect } from "vitest";
import {
  detectRestartLoops,
  type ServiceRestartSnapshot,
} from "../../src/service/restart-loop-detector.js";

const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 3;
const NOW = 1_700_000_000_000;

function snap(name: string, restartHistory: number[]): ServiceRestartSnapshot {
  return { name, restartHistory };
}

describe("detectRestartLoops", () => {
  it("空快照返回空告警", () => {
    expect(detectRestartLoops([], WINDOW_MS, THRESHOLD, NOW)).toEqual([]);
  });

  it("从未重启的服务不告警", () => {
    expect(detectRestartLoops([snap("ok", [])], WINDOW_MS, THRESHOLD, NOW)).toEqual([]);
  });

  it("阈值以下不告警", () => {
    const hist = [NOW - 1000, NOW - 2000];  // 2 次（< 3）
    expect(detectRestartLoops([snap("flaky", hist)], WINDOW_MS, THRESHOLD, NOW)).toEqual([]);
  });

  it("窗口内达到阈值触发告警", () => {
    const hist = [NOW - 1000, NOW - 2000, NOW - 3000];
    const alerts = detectRestartLoops([snap("flaky", hist)], WINDOW_MS, THRESHOLD, NOW);
    expect(alerts).toEqual([
      { name: "flaky", recentRestarts: 3, windowMs: WINDOW_MS },
    ]);
  });

  it("超过阈值也只告一条（多次的不重复）", () => {
    const hist = [NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000, NOW - 5000];
    const alerts = detectRestartLoops([snap("flaky", hist)], WINDOW_MS, THRESHOLD, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].recentRestarts).toBe(5);
  });

  it("窗口外的重启不计入", () => {
    const hist = [
      NOW - 1000,                  // 在窗口内
      NOW - 2 * WINDOW_MS,         // 远超窗口
      NOW - 3 * WINDOW_MS,
    ];
    // 窗口内只有 1 次，不触发
    expect(detectRestartLoops([snap("old-pain", hist)], WINDOW_MS, THRESHOLD, NOW)).toEqual([]);
  });

  it("恰好在窗口边界的重启不计入（半开区间 now-window 不含）", () => {
    const hist = [NOW - WINDOW_MS, NOW - WINDOW_MS, NOW - WINDOW_MS];
    expect(detectRestartLoops([snap("edge", hist)], WINDOW_MS, THRESHOLD, NOW)).toEqual([]);
  });

  it("刚刚过边界 1ms 的算窗口内", () => {
    const hist = [NOW - WINDOW_MS + 1, NOW - WINDOW_MS + 1, NOW - WINDOW_MS + 1];
    const alerts = detectRestartLoops([snap("just-in", hist)], WINDOW_MS, THRESHOLD, NOW);
    expect(alerts).toHaveLength(1);
  });

  it("多服务：每个独立评估", () => {
    const snapshots = [
      snap("calm", [NOW - 1000]),
      snap("loud", [NOW - 1000, NOW - 2000, NOW - 3000]),
      snap("noisy", [NOW - 100, NOW - 200, NOW - 300, NOW - 400]),
    ];
    const alerts = detectRestartLoops(snapshots, WINDOW_MS, THRESHOLD, NOW);
    expect(alerts.map(a => a.name).sort()).toEqual(["loud", "noisy"]);
  });

  it("threshold=1 时一次重启就告警（极端配置可用）", () => {
    const hist = [NOW - 100];
    expect(detectRestartLoops([snap("paranoid", hist)], WINDOW_MS, 1, NOW)).toHaveLength(1);
  });

  it("threshold=0 时永远告警（边界配置不崩）", () => {
    // 不论是否有重启，threshold=0 都视为已达，但空 history 没意义
    expect(detectRestartLoops([snap("never", [])], WINDOW_MS, 0, NOW)).toHaveLength(1);
  });
});
