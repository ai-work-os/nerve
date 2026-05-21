import { describe, it, expect } from "vitest";
import { evaluateNode, evaluateAll } from "../../src/plugins/system-watchdog/evaluator.js";
import type { NodeInfo } from "../../src/transport/protocol.js";

const NOW = 1_700_000_000_000;

function mkNode(overrides: Partial<NodeInfo>): NodeInfo {
  return {
    id: "n1", name: "test", status: "idle",
    capabilities: ["monitor"], permissions: "observer",
    transport: "stdio", channels: [],
    createdAt: NOW - 60_000, lastActiveAt: NOW - 1_000,
    ...overrides,
  };
}

const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_THRESHOLD = 3;

describe("evaluateNode", () => {
  describe("supervised services → restart-loop alerts (via evaluateAll)", () => {
    it("无 supervised 字段 → 无 restart-loop alert", () => {
      const node = mkNode({});
      const alerts = evaluateAll(node, NOW, () => true, () => 50);
      expect(alerts.filter(a => a.metric === "restart-loop")).toEqual([]);
    });

    it("supervised 数组为空 → 无 alert", () => {
      const node = mkNode({ supervised: [] });
      const alerts = evaluateAll(node, NOW, () => true, () => 50);
      expect(alerts.filter(a => a.metric === "restart-loop")).toEqual([]);
    });

    it("窗口内 3 次重启 → 一条 restart-loop alert", () => {
      const node = mkNode({
        supervised: [{
          name: "mac-clipboard", state: "restarting", restarts: 3,
          restartHistory: [NOW - 1000, NOW - 2000, NOW - 3000],
        }],
      });
      const alerts = evaluateAll(node, NOW, () => true, () => 50);
      const loops = alerts.filter(a => a.metric === "restart-loop");
      expect(loops).toHaveLength(1);
      expect(loops[0]).toMatchObject({
        nodeName: "mac-clipboard",
        metric: "restart-loop",
      });
      expect(loops[0].detail).toContain("3");
    });

    it("窗口外的重启不计入", () => {
      const node = mkNode({
        supervised: [{
          name: "old-pain", state: "running", restarts: 3,
          restartHistory: [
            NOW - 1000,
            NOW - 2 * RESTART_WINDOW_MS,
            NOW - 3 * RESTART_WINDOW_MS,
          ],
        }],
      });
      const alerts = evaluateAll(node, NOW, () => true, () => 50);
      expect(alerts.filter(a => a.metric === "restart-loop")).toEqual([]);
    });

    it("多服务：每个独立评估", () => {
      const node = mkNode({
        supervised: [
          { name: "calm", state: "running", restarts: 0, restartHistory: [] },
          {
            name: "loud", state: "restarting", restarts: 3,
            restartHistory: [NOW - 1000, NOW - 2000, NOW - 3000],
          },
          {
            name: "stuck", state: "restarting", restarts: 5,
            restartHistory: [NOW - 100, NOW - 200, NOW - 300, NOW - 400, NOW - 500],
          },
        ],
      });
      const loops = evaluateAll(node, NOW, () => true, () => 50)
        .filter(a => a.metric === "restart-loop");
      expect(loops.map(a => a.nodeName).sort()).toEqual(["loud", "stuck"]);
    });

    it("transport=local 的节点也参与评估（service-supervisor 本身）", () => {
      const node = mkNode({
        transport: "local",
        supervised: [{
          name: "x", state: "restarting", restarts: 3,
          restartHistory: [NOW - 1000, NOW - 2000, NOW - 3000],
        }],
      });
      const loops = evaluateAll(node, NOW, () => true, () => 50)
        .filter(a => a.metric === "restart-loop");
      expect(loops).toHaveLength(1);
    });

    // Window / threshold are configurable; default values are baked in for now.
    void RESTART_WINDOW_MS;
    void RESTART_THRESHOLD;
  });

  it("无 health 契约 → 无 alert", () => {
    const node = mkNode({});
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts).toEqual([]);
  });

  it("liveness=process + pid 死 → liveness alert", () => {
    const node = mkNode({ pid: 12345, health: { liveness: "process" } });
    const alerts = evaluateNode(node, NOW, (pid) => pid !== 12345, () => 50);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ nodeName: "test", metric: "liveness" });
  });

  it("liveness=process + pid 活 → 无 liveness alert", () => {
    const node = mkNode({ pid: 12345, health: { liveness: "process" } });
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts.filter(a => a.metric === "liveness")).toHaveLength(0);
  });

  it("liveness=none → 不检查 pid（即使 pid 死）", () => {
    const node = mkNode({ pid: 12345, health: { liveness: "none" } });
    const alerts = evaluateNode(node, NOW, () => false, () => 50);
    expect(alerts.filter(a => a.metric === "liveness")).toHaveLength(0);
  });

  it("maxIdleMs=60_000 + idle 120s → idle alert", () => {
    const node = mkNode({
      lastActiveAt: NOW - 120_000,
      health: { maxIdleMs: 60_000 },
    });
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ nodeName: "test", metric: "idle" });
    expect(alerts[0].detail).toContain("120");
  });

  it("maxIdleMs=60_000 + idle 30s → 无 idle alert", () => {
    const node = mkNode({
      lastActiveAt: NOW - 30_000,
      health: { maxIdleMs: 60_000 },
    });
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts.filter(a => a.metric === "idle")).toHaveLength(0);
  });

  it("maxIdleMs='none' → 不检查 idle（即使闲很久）", () => {
    const node = mkNode({
      lastActiveAt: NOW - 3_600_000,
      health: { maxIdleMs: "none" },
    });
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts.filter(a => a.metric === "idle")).toHaveLength(0);
  });

  it("maxMemoryMB=100 + 实际 200MB → memory alert", () => {
    const node = mkNode({ pid: 12345, health: { maxMemoryMB: 100 } });
    const alerts = evaluateNode(node, NOW, () => true, () => 200);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ nodeName: "test", metric: "memory" });
    expect(alerts[0].detail).toContain("200");
    expect(alerts[0].detail).toContain("100");
  });

  it("maxMemoryMB=100 + 实际 50MB → 无 memory alert", () => {
    const node = mkNode({ pid: 12345, health: { maxMemoryMB: 100 } });
    const alerts = evaluateNode(node, NOW, () => true, () => 50);
    expect(alerts.filter(a => a.metric === "memory")).toHaveLength(0);
  });

  it("maxMemoryMB 设置但 mem 读取返回 null → 不报警", () => {
    const node = mkNode({ pid: 12345, health: { maxMemoryMB: 100 } });
    const alerts = evaluateNode(node, NOW, () => true, () => null);
    expect(alerts.filter(a => a.metric === "memory")).toHaveLength(0);
  });

  it("多个指标同时触发 → 多个 alert", () => {
    const node = mkNode({
      pid: 12345,
      lastActiveAt: NOW - 200_000,
      health: { liveness: "process", maxIdleMs: 60_000, maxMemoryMB: 100 },
    });
    const alerts = evaluateNode(node, NOW, () => false, () => 200);
    expect(alerts.map(a => a.metric).sort()).toEqual(["idle", "liveness", "memory"]);
  });
});
