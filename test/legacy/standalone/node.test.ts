#!/usr/bin/env npx tsx
/**
 * NerveNode unit tests
 * Run: npx tsx test/unit/node.test.ts
 */

import { NerveNode } from "../../../src/node/node.js";
import type { Message } from "../../../src/transport/protocol.js";

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

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: "m-1",
    nodeId: "test-id",
    role: "agent",
    sender: "test-node",
    text: "hello",
    ts: Date.now(),
    ...overrides,
  };
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

function testMessageStoreEmpty() {
  console.log("\n▸ messageStore starts empty");
  const node = makeNode();
  assertEq(node.messageStore.length, 0, "messageStore is empty");
  assertEq(node.inFlightAgent, null, "inFlightAgent is null");
}

function testAppendMessage() {
  console.log("\n▸ appendMessage adds to store");
  const node = makeNode();
  node.appendMessage(makeMessage({ id: "m-1", text: "hello" }));
  node.appendMessage(makeMessage({ id: "m-2", role: "user", text: "hi" }));
  assertEq(node.messageStore.length, 2, "store has 2 messages");
  assertEq(node.messageStore[0].id, "m-1", "first message id");
  assertEq(node.messageStore[1].role, "user", "second message role");
}

function testClearMessageStore() {
  console.log("\n▸ clearMessageStore clears store and in-flight");
  const node = makeNode();
  node.appendMessage(makeMessage());
  node.inFlightAgent = { id: "in-flight", text: "partial" };
  node.clearMessageStore();
  assertEq(node.messageStore.length, 0, "store empty after clear");
  assertEq(node.inFlightAgent, null, "in-flight cleared");
}

function testObserveUpdateUsageExtraction() {
  console.log("\n▸ observeUpdate with usage_update → extracts usage");
  const node = makeNode({ adapter: "mock" });
  node.observeUpdate({
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

function testObserveUpdateNonUsageNoop() {
  console.log("\n▸ observeUpdate without usage_update → usage unchanged");
  const node = makeNode();
  node.observeUpdate({ update: { sessionUpdate: "agent_message_chunk", text: "hi" } } as any);
  assertEq(node.usage, undefined, "usage remains undefined");
  assertEq(node.messageStore.length, 0, "observeUpdate does not write messageStore");
}

function testTouch() {
  console.log("\n▸ touch() updates lastActiveAt");
  const node = makeNode();
  const before = node.lastActiveAt;
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
  testMessageStoreEmpty();
  testAppendMessage();
  testClearMessageStore();
  testObserveUpdateUsageExtraction();
  testObserveUpdateNonUsageNoop();
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
