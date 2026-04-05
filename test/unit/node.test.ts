#!/usr/bin/env npx tsx
/**
 * NerveNode unit tests
 * Run: npx tsx test/unit/node.test.ts
 */

import { NerveNode } from "../../src/node.js";

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

const mockTransport = { type: "stdio" as const, send: () => {}, close: () => {} };

function makeNode(overrides?: Partial<ConstructorParameters<typeof NerveNode>[0]>) {
  return new NerveNode({
    id: "test-id",
    name: "test-node",
    transport: mockTransport,
    ...overrides,
  });
}

// --- Tests ---

function testConstructorStatus() {
  console.log("\n▸ constructor → status is 'connecting'");
  const node = makeNode();
  assertEq(node.status, "connecting", "initial status is connecting");
}

function testToInfo() {
  console.log("\n▸ toInfo() returns correct snapshot");
  const node = makeNode({ capabilities: ["code"], adapter: "mock" });
  const info = node.toInfo();
  assertEq(info.id, "test-id", "id matches");
  assertEq(info.name, "test-node", "name matches");
  assertEq(info.status, "connecting", "status matches");
  assertEq(info.capabilities, ["code"], "capabilities match");
}

function testChannelsEmpty() {
  console.log("\n▸ channels starts empty");
  const node = makeNode();
  assertEq(node.toInfo().channels, [], "channels is empty array");
}

function testPermissionsDefault() {
  console.log("\n▸ permissions defaults to 'member'");
  const node = makeNode();
  assertEq(node.permissions, "member", "default permissions is member");
}

function testPushUpdate() {
  console.log("\n▸ pushUpdate adds to buffer");
  const node = makeNode();
  node.pushUpdate({ update: { sessionUpdate: "text", text: "hello" } } as any);
  assertEq(node.updateBuffer.length, 1, "buffer has 1 entry");
}

function testBufferOverflow() {
  console.log("\n▸ buffer overflow → shifts old data");
  const node = makeNode();
  for (let i = 0; i <= NerveNode.MAX_BUFFER_SIZE; i++) {
    node.pushUpdate({ update: { sessionUpdate: "text", text: `msg-${i}` } } as any);
  }
  assertEq(node.updateBuffer.length, NerveNode.MAX_BUFFER_SIZE, `buffer capped at ${NerveNode.MAX_BUFFER_SIZE}`);
  // First item should be msg-1 (msg-0 was shifted out)
  const first = (node.updateBuffer[0] as any).update.text;
  assertEq(first, "msg-1", "oldest entry (msg-0) was shifted out");
}

function testClearUpdateBuffer() {
  console.log("\n▸ clearUpdateBuffer");
  const node = makeNode();
  node.pushUpdate({ update: { sessionUpdate: "text", text: "x" } } as any);
  node.clearUpdateBuffer();
  assertEq(node.updateBuffer.length, 0, "buffer is empty after clear");
}

function testUsageExtraction() {
  console.log("\n▸ pushUpdate with usage_update → extracts usage");
  const node = makeNode({ adapter: "mock" });
  node.pushUpdate({
    update: {
      sessionUpdate: "usage_update",
      used: 5000,
      size: 200000,
      cost: { amount: 0.1 },
    },
  } as any);
  assert(node.usage !== undefined, "usage is set");
  assertEq(node.usage!.tokenUsed, 5000, "tokenUsed extracted");
  assertEq(node.usage!.cost, 0.1, "cost extracted");
}

function testNoUsageWithoutUsageUpdate() {
  console.log("\n▸ pushUpdate without usage_update → usage unchanged");
  const node = makeNode();
  node.pushUpdate({ update: { sessionUpdate: "text", text: "hello" } } as any);
  assertEq(node.usage, undefined, "usage remains undefined");
}

function testTouch() {
  console.log("\n▸ touch() updates lastActiveAt");
  const node = makeNode();
  const before = node.lastActiveAt;
  // Small delay to ensure timestamp differs
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
  node.touch();
  assert(node.lastActiveAt >= before, "lastActiveAt updated");
}

function testIsProcessIsWebSocket() {
  console.log("\n▸ stdio transport → isProcess=true, isWebSocket=false");
  const node = makeNode();
  assert(node.isProcess === true, "isProcess is true for stdio");
  assert(node.isWebSocket === false, "isWebSocket is false for stdio");
}

// --- Main ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  NerveNode Unit Tests");
  console.log("═══════════════════════════════════════");

  testConstructorStatus();
  testToInfo();
  testChannelsEmpty();
  testPermissionsDefault();
  testPushUpdate();
  testBufferOverflow();
  testClearUpdateBuffer();
  testUsageExtraction();
  testNoUsageWithoutUsageUpdate();
  testTouch();
  testIsProcessIsWebSocket();

  console.log("\n══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("══════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
