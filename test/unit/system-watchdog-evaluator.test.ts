import { describe, it, expect } from "vitest";
import { evaluateNode } from "../../src/plugins/system-watchdog/evaluator.js";
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

describe("evaluateNode", () => {
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
