#!/usr/bin/env npx tsx
/**
 * _setNodeStatus 收敛测试（TDD 红阶段）
 *
 * 验证 Fix A (P0-1 + P1-1 + P1-2)：
 * 1. promptNode 设 busy 后 store 有对应记录
 * 2. promptNode 成功后 store 状态回 idle
 * 3. promptNode 失败后 store 状态回 idle
 * 4. cancelNode 后 store 状态回 idle
 * 5. 状态未变时不重复 emit statusChanged
 * 6. 状态变 idle 时 activity 自动清空
 *
 * 运行: npx tsx test/test-set-node-status.ts
 */

import { NodePool } from "../../src/node-pool.js";
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

// --- Mock store that records calls ---

interface StoreCall {
  method: string;
  args: unknown[];
}

function createRecordingStore(): { store: any; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const store = {
    insertNode(...args: unknown[]) { calls.push({ method: "insertNode", args }); },
    updateNodeStatus(...args: unknown[]) { calls.push({ method: "updateNodeStatus", args }); },
  };
  return { store, calls };
}

// --- Mock transport ---

function createMockTransport() {
  const handlers: Array<(code?: number) => void> = [];
  return {
    alive: true,
    type: "stdio" as const,
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

// --- Mock ACP client ---

function createMockAcpClient(opts?: {
  promptResult?: { stopReason?: string; error?: string };
  promptReject?: Error;
}) {
  return {
    prompt: async (_text: string) => {
      if (opts?.promptReject) throw opts.promptReject;
      return opts?.promptResult ?? { stopReason: "end_turn" };
    },
    cancel: async () => ({}),
    closeSession: async () => {},
    cleanup() {},
    sessionId: "test-session",
  };
}

// --- Helpers ---

function createPool(store: any): {
  pool: NodePool;
  events: Array<{ event: string; node: NerveNode; detail?: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; node: NerveNode; detail?: Record<string, unknown> }> = [];
  const pool = new NodePool(store, (event, node, detail) => {
    events.push({ event, node, detail });
  });
  return { pool, events };
}

function registerNode(pool: NodePool, name: string, opts?: { status?: string }): {
  id: string;
  node: NerveNode;
} {
  const p = pool as any;
  const id = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const transport = createMockTransport();
  const node = new NerveNode({
    id,
    name,
    transport: transport as any,
    capabilities: ["code"],
    adapter: "mock",
    cwd: "/tmp",
  });
  node.status = (opts?.status as any) ?? "idle";
  p.nodes.set(id, node);
  p.nameIndex.set(name, id);
  return { id, node };
}

function getStatusCalls(calls: StoreCall[]): StoreCall[] {
  return calls.filter(c => c.method === "updateNodeStatus");
}

function countEvents(events: Array<{ event: string }>, eventName: string): number {
  return events.filter(e => e.event === eventName).length;
}

// --- Tests ---

async function test1_promptNodeSetsBusyInStore() {
  console.log("\n▸ T1: promptNode 设 busy 后 store 有对应记录");

  const { store, calls } = createRecordingStore();
  const { pool, events } = createPool(store);
  const { id, node } = registerNode(pool, "agent-1");
  const p = pool as any;

  // Mock ACP client that blocks until we resolve
  let resolvePrompt: (v: any) => void;
  const promptPromise = new Promise(r => { resolvePrompt = r; });
  p.acpClients.set(id, {
    prompt: () => promptPromise,
    cancel: async () => ({}),
    closeSession: async () => {},
    cleanup() {},
  });

  // Start prompt (don't await — we want to check intermediate state)
  const resultPromise = pool.promptNode(id, "hello");

  // Give the event loop a tick for promptNode to set busy
  await new Promise(r => setTimeout(r, 10));

  // Check: node should be busy
  assertEq(node.status, "busy", "node status is busy");

  // Check: store.updateNodeStatus should have been called with "busy"
  const busyCalls = getStatusCalls(calls).filter(c => c.args[1] === "busy");
  assert(busyCalls.length >= 1, "store.updateNodeStatus called with 'busy'",
    `got ${busyCalls.length} calls, all status calls: ${JSON.stringify(getStatusCalls(calls).map(c => c.args))}`);

  // Cleanup: resolve the prompt so it doesn't hang
  resolvePrompt!({ stopReason: "end_turn" });
  await resultPromise;
}

async function test2_promptNodeSuccessSetsIdleInStore() {
  console.log("\n▸ T2: promptNode 成功后 store 状态回 idle");

  const { store, calls } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-2");
  const p = pool as any;

  p.acpClients.set(id, createMockAcpClient({ promptResult: { stopReason: "end_turn" } }));

  await pool.promptNode(id, "do something");

  // After prompt completes, node should be idle
  assertEq(node.status, "idle", "node status is idle after success");

  // store should have been called with "idle" after prompt completion
  const idleCalls = getStatusCalls(calls).filter(c => c.args[1] === "idle");
  assert(idleCalls.length >= 1, "store.updateNodeStatus called with 'idle' after success",
    `got ${idleCalls.length} calls, all status calls: ${JSON.stringify(getStatusCalls(calls).map(c => c.args))}`);
}

async function test3_promptNodeErrorSetsIdleInStore() {
  console.log("\n▸ T3: promptNode 失败后 store 状态回 idle");

  const { store, calls } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-3");
  const p = pool as any;

  p.acpClients.set(id, createMockAcpClient({ promptReject: new Error("prompt failed") }));

  const result = await pool.promptNode(id, "fail please");

  // Should return error
  assert(!!result.error, "promptNode returns error");

  // Node should be idle
  assertEq(node.status, "idle", "node status is idle after error");

  // store should have been called with "idle" after error
  const idleCalls = getStatusCalls(calls).filter(c => c.args[1] === "idle");
  assert(idleCalls.length >= 1, "store.updateNodeStatus called with 'idle' after error",
    `got ${idleCalls.length} calls, all status calls: ${JSON.stringify(getStatusCalls(calls).map(c => c.args))}`);
}

async function test4_cancelNodeSetsIdleInStore() {
  console.log("\n▸ T4: cancelNode 后 store 状态回 idle");

  const { store, calls } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-4", { status: "busy" });
  const p = pool as any;

  node.activity = "thinking";
  p.acpClients.set(id, createMockAcpClient());

  await pool.cancelNode(id);

  // Node should be idle
  assertEq(node.status, "idle", "node status is idle after cancel");

  // store should have been called with "idle"
  const idleCalls = getStatusCalls(calls).filter(c => c.args[1] === "idle");
  assert(idleCalls.length >= 1, "store.updateNodeStatus called with 'idle' after cancel",
    `got ${idleCalls.length} calls, all status calls: ${JSON.stringify(getStatusCalls(calls).map(c => c.args))}`);
}

async function test5_noDoubleEmitWhenStatusUnchanged() {
  console.log("\n▸ T5: 状态未变时不重复 emit statusChanged");

  const { store } = createRecordingStore();
  const { pool, events } = createPool(store);
  const { id, node } = registerNode(pool, "agent-5");
  const p = pool as any;

  // Node is already idle. If something tries to set it idle again, should NOT emit.
  // Simulate: cancelNode when node is already idle
  p.acpClients.set(id, createMockAcpClient());

  // Record event count before
  const beforeCount = countEvents(events, "node.statusChanged");

  await pool.cancelNode(id);

  // cancelNode should NOT emit statusChanged because status was already "idle"
  const afterCount = countEvents(events, "node.statusChanged");
  assertEq(afterCount - beforeCount, 0, "no statusChanged emitted when status unchanged (idle→idle)",
    `got ${afterCount - beforeCount} extra emit(s)`);
}

async function test6_activityClearedOnIdleTransition() {
  console.log("\n▸ T6: 状态变 idle 时 activity 自动清空");

  const { store } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-6", { status: "busy" });
  const p = pool as any;

  // Set activity before transitioning to idle
  node.activity = "tool: search";

  p.acpClients.set(id, createMockAcpClient());

  await pool.cancelNode(id);

  // activity should be cleared when status goes to idle
  assert(node.activity === undefined, "activity cleared after cancel → idle",
    `activity is "${node.activity}"`);
}

async function test6b_activityClearedOnPromptSuccess() {
  console.log("\n▸ T6b: promptNode 成功后 activity 自动清空");

  const { store } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-6b");
  const p = pool as any;

  p.acpClients.set(id, createMockAcpClient({ promptResult: { stopReason: "end_turn" } }));

  // promptNode sets busy internally, sets activity during ACP callback in real code
  // We manually set activity to simulate mid-prompt state
  node.activity = "thinking";

  await pool.promptNode(id, "think about something");

  assert(node.activity === undefined, "activity cleared after prompt success",
    `activity is "${node.activity}"`);
}

async function test6c_activityClearedOnPromptError() {
  console.log("\n▸ T6c: promptNode 失败后 activity 自动清空");

  const { store } = createRecordingStore();
  const { pool } = createPool(store);
  const { id, node } = registerNode(pool, "agent-6c");
  const p = pool as any;

  p.acpClients.set(id, createMockAcpClient({ promptReject: new Error("boom") }));
  node.activity = "tool: write";

  await pool.promptNode(id, "fail");

  assert(node.activity === undefined, "activity cleared after prompt error",
    `activity is "${node.activity}"`);
}

// --- Main ---

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  _setNodeStatus 收敛测试（TDD 红阶段）    ║");
  console.log("╚══════════════════════════════════════════╝");

  await test1_promptNodeSetsBusyInStore();
  await test2_promptNodeSuccessSetsIdleInStore();
  await test3_promptNodeErrorSetsIdleInStore();
  await test4_cancelNodeSetsIdleInStore();
  await test5_noDoubleEmitWhenStatusUnchanged();
  await test6_activityClearedOnIdleTransition();
  await test6b_activityClearedOnPromptSuccess();
  await test6c_activityClearedOnPromptError();

  console.log("\n" + "═".repeat(42));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
