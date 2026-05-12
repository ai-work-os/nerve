#!/usr/bin/env npx tsx
/**
 * ChannelStore unit tests
 * Run: npx tsx test/unit/channel-store.test.ts
 */

import { ChannelStore } from "../../../src/storage/channel-store.js";
import { Store } from "../../../src/storage/store.js";

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
// ChannelStore
// ============================================================

function testCreate() {
  console.log("\n\u25b8 ChannelStore: create");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp", "test-ch");
  assert(typeof ch.id === "string" && ch.id.length > 0, "channel has id");
  assertEq(ch.name, "test-ch", "channel has name");
  assertEq(ch.cwd, "/tmp", "channel has cwd");
  store.close();
}

function testGetExists() {
  console.log("\n\u25b8 ChannelStore: get existing");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp");
  assertEq(cs.get(ch.id)?.id, ch.id, "get returns created channel");
  store.close();
}

function testGetNotExists() {
  console.log("\n\u25b8 ChannelStore: get non-existing");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  assertEq(cs.get("nope"), undefined, "get returns undefined");
  store.close();
}

function testListEmpty() {
  console.log("\n\u25b8 ChannelStore: list empty");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  assertEq(cs.list().length, 0, "empty list");
  store.close();
}

function testListWithChannels() {
  console.log("\n\u25b8 ChannelStore: list with channels");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  cs.create("/tmp", "a");
  cs.create("/tmp", "b");
  assertEq(cs.list().length, 2, "two channels");
  store.close();
}

function testHas() {
  console.log("\n\u25b8 ChannelStore: has");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp");
  assert(cs.has(ch.id), "has returns true for existing");
  assert(!cs.has("nope"), "has returns false for non-existing");
  store.close();
}

function testClose() {
  console.log("\n\u25b8 ChannelStore: close removes from list");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp", "to-close");
  cs.close(ch.id);
  assertEq(cs.list().length, 0, "channel removed from list");
  assert(!cs.has(ch.id), "has returns false after close");
  store.close();
}

function testDelete() {
  console.log("\n\u25b8 ChannelStore: delete cascades in DB");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp", "to-delete");
  // Insert a message via store directly
  store.insertMessage({ id: "m1", channelId: ch.id, from: "user", content: "hi", timestamp: 100 });
  cs.delete(ch.id);
  assertEq(cs.list().length, 0, "channel removed from list");
  assertEq(store.getMessages(ch.id).length, 0, "messages deleted from DB");
  store.close();
}

function testRestore() {
  console.log("\n\u25b8 ChannelStore: restore from DB");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp", "restorable");
  const chId = ch.id;
  // Insert message
  store.insertMessage({ id: "m1", channelId: chId, from: "user", content: "hello", timestamp: 100 });
  // Remove from in-memory map (simulate restart)
  cs.close(chId);
  // But don't delete from DB — closeChannel marks closed_at, so restore won't find it via listChannels
  // We need to use a fresh ChannelStore that doesn't know about the channel
  const cs2 = new ChannelStore(store);
  const result = cs2.restore(chId);
  assert(result !== null, "restore returns non-null");
  assertEq(result!.channel.id, chId, "restored channel id matches");
  assertEq(result!.messages.length, 1, "restored with 1 message");
  assertEq(result!.messages[0].content, "hello", "message content matches");
  store.close();
}

function testRestoreAlreadyLoaded() {
  console.log("\n\u25b8 ChannelStore: restore already-loaded channel");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  const ch = cs.create("/tmp", "loaded");
  store.insertMessage({ id: "m1", channelId: ch.id, from: "user", content: "hi", timestamp: 100 });
  const result = cs.restore(ch.id);
  assert(result !== null, "restore returns non-null for loaded channel");
  assertEq(result!.channel.id, ch.id, "same channel returned");
  assertEq(result!.messages.length, 1, "messages included");
  store.close();
}

function testRestoreNotFound() {
  console.log("\n\u25b8 ChannelStore: restore non-existing");
  const store = new Store(":memory:");
  const cs = new ChannelStore(store);
  assertEq(cs.restore("nope"), null, "returns null for unknown id");
  store.close();
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log("  ChannelStore Tests");
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

  testCreate();
  testGetExists();
  testGetNotExists();
  testListEmpty();
  testListWithChannels();
  testHas();
  testClose();
  testDelete();
  testRestore();
  testRestoreAlreadyLoaded();
  testRestoreNotFound();

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
