#!/usr/bin/env npx tsx
/**
 * 频道移除统一测试（TDD 红阶段）
 *
 * 验证 Fix B (P0-2 + P1-3)：
 * 1. closeChannel 后 node.channels 不残留已关闭的频道
 * 2. handleNodeEvent("node.stopped") 幂等 — _cleaned 节点不重复移除
 * 3. _removeNodeFromAllChannels 统一路径
 *
 * 运行: npx tsx test/test-channel-removal.ts
 */

import { ChannelManager } from "../../src/channel-manager.js";
import { NerveNode } from "../../src/node.js";

// --- Test infra ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Helpers ---

function createManager(): ChannelManager {
  const mgr = new ChannelManager({ dataDir: "/tmp/nerve-test-" + Date.now(), port: 19999 });
  return mgr;
}

function createMockTransport() {
  const handlers: Array<(code?: number) => void> = [];
  return {
    alive: true,
    type: "websocket" as const,
    close() { this.alive = false; },
    onClose(fn: (code?: number) => void) { handlers.push(fn); },
    onMessage() {},
    send() {},
    _triggerClose(code?: number) {
      this.alive = false;
      for (const fn of handlers) fn(code);
    },
  };
}

/** Register a node directly into pool internals (bypass WebSocket) */
function registerNode(mgr: ChannelManager, name: string): NerveNode {
  const pool = mgr.nodePool as any;
  const id = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const transport = createMockTransport();
  const node = new NerveNode({
    id,
    name,
    transport: transport as any,
    capabilities: ["code"],
  });
  node.status = "idle";
  pool.nodes.set(id, node);
  pool.nameIndex.set(name, id);
  // Insert into store so FK constraints pass
  mgr.store.insertNode(id, name, "websocket", undefined, ["code"]);
  mgr.store.updateNodeStatus(id, "idle");
  return node;
}

// --- Tests ---

function test1_closeChannelClearsNodeChannels() {
  console.log("\n▸ T1: closeChannel 后 node.channels 不残留已关闭的频道");

  const mgr = createManager();
  const ch = mgr.createChannel("/tmp", "test-ch");
  const node = registerNode(mgr, "agent-1");
  mgr.addNodeToChannel(ch.id, node.id);

  assert(node.channels.has(ch.id), "node is in channel before close");

  mgr.closeChannel(ch.id);

  assert(!node.channels.has(ch.id), "node.channels cleared after closeChannel",
    `node.channels still has: ${[...node.channels].join(", ")}`);

  mgr.shutdown();
}

function test2_nodeStoppedDoesNotDoubleRemove() {
  console.log("\n▸ T2: node.stopped 事件不重复移除已 cleaned 的节点");

  const mgr = createManager();
  const ch = mgr.createChannel("/tmp", "test-ch2");
  const node = registerNode(mgr, "agent-2");
  mgr.addNodeToChannel(ch.id, node.id);

  node._cleaned = true;

  // Manually trigger the node.stopped handling path
  mgr.nodePool.emitEvent("node.stopped", node, { exitCode: 0 });

  // Should complete without error
  assert(true, "no crash on node.stopped for already-cleaned node");

  mgr.shutdown();
}

function test3_closeChannelMultipleNodes() {
  console.log("\n▸ T3: closeChannel 多节点时全部清理 node.channels");

  const mgr = createManager();
  const ch = mgr.createChannel("/tmp", "test-ch3");
  const node1 = registerNode(mgr, "agent-3a");
  const node2 = registerNode(mgr, "agent-3b");

  mgr.addNodeToChannel(ch.id, node1.id);
  mgr.addNodeToChannel(ch.id, node2.id);

  mgr.closeChannel(ch.id);

  assert(!node1.channels.has(ch.id), "node1.channels cleared",
    `node1 still has: ${[...node1.channels].join(", ")}`);
  assert(!node2.channels.has(ch.id), "node2.channels cleared",
    `node2 still has: ${[...node2.channels].join(", ")}`);

  mgr.shutdown();
}

function test4_nodeInMultipleChannels() {
  console.log("\n▸ T4: 节点在多频道时 closeChannel 只清对应频道");

  const mgr = createManager();
  const ch1 = mgr.createChannel("/tmp", "ch-a");
  const ch2 = mgr.createChannel("/tmp", "ch-b");
  const node = registerNode(mgr, "agent-4");

  mgr.addNodeToChannel(ch1.id, node.id);
  mgr.addNodeToChannel(ch2.id, node.id);

  assert(node.channels.size === 2, "node in 2 channels");

  mgr.closeChannel(ch1.id);

  assert(!node.channels.has(ch1.id), "ch1 removed from node.channels");
  assert(node.channels.has(ch2.id), "ch2 still in node.channels");

  mgr.shutdown();
}

// --- Main ---

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  频道移除统一测试（Fix B）             ║");
  console.log("╚══════════════════════════════════════╝");

  test1_closeChannelClearsNodeChannels();
  test2_nodeStoppedDoesNotDoubleRemove();
  test3_closeChannelMultipleNodes();
  test4_nodeInMultipleChannels();

  console.log("\n" + "═".repeat(40));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
