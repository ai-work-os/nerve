#!/usr/bin/env npx tsx
/**
 * Store unit tests — in-memory mode
 * Run: npx tsx test/unit/store.test.ts
 */

import { Store } from "../../src/store.js";

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  \u2717 ${name}${detail ? " \u2014 " + detail : ""}`);
  }
}

function assertEq(actual: unknown, expected: unknown, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, name, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ============================================================
// Store in-memory
// ============================================================

function testConstructor() {
  console.log("\n\u25b8 Store: in-memory constructor");
  let ok = true;
  try {
    const s = new Store(":memory:");
    s.close();
  } catch (e) {
    ok = false;
  }
  assert(ok, "new Store(':memory:') does not throw");
}

function testChannelCRUD() {
  console.log("\n\u25b8 Store: insertChannel + listChannels");
  const s = new Store(":memory:");
  s.insertChannel("ch-1", "/tmp", "test-channel");
  const channels = s.listChannels();
  assertEq(channels.length, 1, "one channel listed");
  assertEq(channels[0].id, "ch-1", "channel id matches");
  assertEq(channels[0].name, "test-channel", "channel name matches");
  s.close();
}

function testNodeCRUD() {
  console.log("\n\u25b8 Store: insertNode + updateNodeStatus");
  const s = new Store(":memory:");
  s.insertNode("n-1", "agent-1", "stdio", "claude");
  s.updateNodeStatus("n-1", "idle", "sess-1");
  // No throw = success (no public getter for nodes, just verify no error)
  assert(true, "insertNode + updateNodeStatus no error");
  s.close();
}

function testMessageCRUD() {
  console.log("\n\u25b8 Store: insertMessage + getMessages (sorted)");
  const s = new Store(":memory:");
  s.insertChannel("ch-1", "/tmp");
  s.insertMessage({ id: "m-2", channelId: "ch-1", from: "bob", content: "second", timestamp: 200 });
  s.insertMessage({ id: "m-1", channelId: "ch-1", from: "alice", content: "first", timestamp: 100 });
  const msgs = s.getMessages("ch-1");
  assertEq(msgs.length, 2, "two messages");
  assertEq(msgs[0].from, "alice", "first by timestamp is alice");
  assertEq(msgs[1].from, "bob", "second by timestamp is bob");
  s.close();
}

function testDmMessageCRUD() {
  console.log("\n▸ Store: insertDmMessage + getDmMessages (sorted)");
  const s = new Store(":memory:");
  s.insertDmMessage({ id: "dm-2", nodeId: "n-1", role: "agent", sender: "claude", text: "second", ts: 200 });
  s.insertDmMessage({ id: "dm-1", nodeId: "n-1", role: "user", sender: "renjinxi", text: "first", ts: 100 });
  const msgs = s.getDmMessages("n-1");
  assertEq(msgs.length, 2, "two dm messages");
  assertEq(msgs[0].role, "user", "first by timestamp is user");
  assertEq(msgs[1].role, "agent", "second by timestamp is agent");
  s.close();
}

function testChannelNodes() {
  console.log("\n\u25b8 Store: addNodeToChannel + getChannelNodes");
  const s = new Store(":memory:");
  s.insertChannel("ch-1", "/tmp");
  s.insertNode("n-1", "agent-1", "stdio");
  s.addNodeToChannel("ch-1", "n-1", "agent-1");
  const nodes = s.getChannelNodes("ch-1");
  assertEq(nodes.length, 1, "one node in channel");
  assertEq(nodes[0].nodeName, "agent-1", "node name matches");
  s.close();
}

function testDeleteChannelCascade() {
  console.log("\n\u25b8 Store: deleteChannel cascades messages + channel_nodes");
  const s = new Store(":memory:");
  s.insertChannel("ch-1", "/tmp");
  s.insertNode("n-1", "agent-1", "stdio");
  s.addNodeToChannel("ch-1", "n-1", "agent-1");
  s.insertMessage({ id: "m-1", channelId: "ch-1", from: "agent-1", content: "hi", timestamp: 100 });
  s.deleteChannel("ch-1");
  const channels = s.listChannels();
  const msgs = s.getMessages("ch-1");
  const nodes = s.getChannelNodes("ch-1");
  assertEq(channels.length, 0, "no channels after delete");
  assertEq(msgs.length, 0, "no messages after delete");
  assertEq(nodes.length, 0, "no channel_nodes after delete");
  s.close();
}

function testMarkAllNodesStopped() {
  console.log("\n\u25b8 Store: markAllNodesStopped");
  const s = new Store(":memory:");
  s.insertNode("n-1", "a1", "stdio");
  s.insertNode("n-2", "a2", "stdio");
  s.updateNodeStatus("n-1", "idle");
  s.updateNodeStatus("n-2", "busy");
  s.markAllNodesStopped();
  // No public way to query node status, just verify no error
  assert(true, "markAllNodesStopped no error");
  s.close();
}

function testClose() {
  console.log("\n\u25b8 Store: close");
  const s = new Store(":memory:");
  let ok = true;
  try {
    s.close();
  } catch {
    ok = false;
  }
  assert(ok, "close does not throw");
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log("  Store Tests (in-memory mode)");
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

  testConstructor();
  testChannelCRUD();
  testNodeCRUD();
  testMessageCRUD();
  testDmMessageCRUD();
  testChannelNodes();
  testDeleteChannelCascade();
  testMarkAllNodesStopped();
  testClose();

  console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    \u2717 ${f}`);
  }
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
