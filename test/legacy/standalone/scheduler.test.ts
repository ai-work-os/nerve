#!/usr/bin/env npx tsx
/**
 * Scheduler unit tests
 * Run: npx tsx test/unit/scheduler.test.ts
 */

import { Scheduler } from "../../../src/scheduler.js";
import type { MessageInfo } from "../../../src/protocol.js";

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

function makeMsg(content: string): MessageInfo {
  return { from: "user", content, timestamp: Date.now() };
}

// --- Tests ---

function testEnqueueEmptyDispatchesImmediately() {
  console.log("\n▸ enqueue empty queue → immediate dispatch");
  let called = false;
  let calledNodeId = "";
  let calledText = "";
  const s = new Scheduler((nodeId, text, onDone) => {
    called = true;
    calledNodeId = nodeId;
    calledText = text;
  });
  const result = s.enqueue("n1", "ch1", makeMsg("hello"));
  assert(result === true, "enqueue returns true");
  assert(called, "promptFn called immediately");
  assertEq(calledNodeId, "n1", "promptFn receives correct nodeId");
  assertEq(calledText, "hello", "promptFn receives correct text");
}

function testEnqueueBusyQueues() {
  console.log("\n▸ enqueue when busy → queues without dispatch");
  let callCount = 0;
  const s = new Scheduler(() => { callCount++; });
  s.enqueue("n1", "ch1", makeMsg("first"));
  assertEq(callCount, 1, "first enqueue dispatches");
  s.enqueue("n1", "ch1", makeMsg("second"));
  assertEq(callCount, 1, "second enqueue does NOT dispatch (busy)");
}

function testOnDoneDispatchesNext() {
  console.log("\n▸ onDone → auto dispatch next (FIFO)");
  const dispatched: string[] = [];
  let savedOnDone: (() => void) | null = null;
  const s = new Scheduler((_nodeId, text, onDone) => {
    dispatched.push(text);
    savedOnDone = onDone;
  });
  s.enqueue("n1", "ch1", makeMsg("A"));
  s.enqueue("n1", "ch1", makeMsg("B"));
  s.enqueue("n1", "ch1", makeMsg("C"));
  assertEq(dispatched, ["A"], "only A dispatched initially");
  savedOnDone!();
  assertEq(dispatched, ["A", "B"], "B dispatched after A done");
  savedOnDone!();
  assertEq(dispatched, ["A", "B", "C"], "C dispatched after B done (FIFO)");
}

function testQueueFull() {
  console.log("\n▸ queue full (maxQueueSize=10) → enqueue returns false");
  const s = new Scheduler(() => {}); // first enqueue dispatches, holds busy
  s.enqueue("n1", "ch1", makeMsg("dispatch")); // dispatched, busy
  for (let i = 0; i < 10; i++) {
    assert(s.enqueue("n1", "ch1", makeMsg(`q${i}`)) === true, `enqueue #${i + 1} ok`);
  }
  const result = s.enqueue("n1", "ch1", makeMsg("overflow"));
  assert(result === false, "11th enqueue returns false (queue full)");
}

function testIsNodeBusy() {
  console.log("\n▸ isNodeBusy");
  let onDoneFn: (() => void) | null = null;
  const s = new Scheduler((_n, _t, onDone) => { onDoneFn = onDone; });
  assert(!s.isNodeBusy("n1"), "not busy before enqueue");
  s.enqueue("n1", "ch1", makeMsg("x"));
  assert(s.isNodeBusy("n1"), "busy after enqueue");
  onDoneFn!(); // finish, no more items
  assert(!s.isNodeBusy("n1"), "not busy after onDone with empty queue");
}

function testClearQueue() {
  console.log("\n▸ clearQueue");
  const s = new Scheduler(() => {});
  s.enqueue("n1", "ch1", makeMsg("a"));
  s.enqueue("n1", "ch1", makeMsg("b"));
  assert(s.isNodeBusy("n1"), "busy before clear");
  s.clearQueue("n1");
  assert(!s.isNodeBusy("n1"), "not busy after clear");
}

function testMultiNodeIndependentQueues() {
  console.log("\n▸ multi-node independent queues");
  let callCount = 0;
  const s = new Scheduler(() => { callCount++; });
  s.enqueue("nA", "ch1", makeMsg("a1"));
  assertEq(callCount, 1, "nA dispatched");
  assert(s.isNodeBusy("nA"), "nA is busy");
  assert(!s.isNodeBusy("nB"), "nB is not busy");
  s.enqueue("nB", "ch1", makeMsg("b1"));
  assertEq(callCount, 2, "nB dispatched independently");
  assert(s.isNodeBusy("nB"), "nB is now busy");
}

function testFIFOOrder() {
  console.log("\n▸ FIFO order verification");
  const order: string[] = [];
  let savedOnDone: (() => void) | null = null;
  const s = new Scheduler((_n, text, onDone) => {
    order.push(text);
    savedOnDone = onDone;
  });
  s.enqueue("n1", "ch1", makeMsg("1st"));
  s.enqueue("n1", "ch1", makeMsg("2nd"));
  s.enqueue("n1", "ch1", makeMsg("3rd"));
  savedOnDone!();
  savedOnDone!();
  assertEq(order, ["1st", "2nd", "3rd"], "dispatched in FIFO order");
}

// --- Main ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Scheduler Unit Tests");
  console.log("═══════════════════════════════════════");

  testEnqueueEmptyDispatchesImmediately();
  testEnqueueBusyQueues();
  testOnDoneDispatchesNext();
  testQueueFull();
  testIsNodeBusy();
  testClearQueue();
  testMultiNodeIndependentQueues();
  testFIFOOrder();

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
