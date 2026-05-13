#!/usr/bin/env npx tsx
/**
 * NodePool unit tests
 * Run: npx tsx test/unit/node-pool.test.ts
 */

import { NodePool } from "../../../src/node/node-pool.js";

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

const mockStore = {
  insertNode() {},
  updateNodeStatus() {},
  markAllNodesStopped() {},
  addNodeToChannel() {},
  removeNodeFromChannel() {},
  insertDmMessage() {},
} as any;

function makePool() {
  return new NodePool(mockStore, () => {});
}

// --- Tests ---

function testConstructor() {
  console.log("\n▸ constructor does not throw");
  let err: Error | null = null;
  try { makePool(); } catch (e: any) { err = e; }
  assert(err === null, "NodePool constructor succeeds");
}

function testGetUndefined() {
  console.log("\n▸ get(nonexistent) → undefined");
  const pool = makePool();
  assertEq(pool.get("nonexistent"), undefined, "returns undefined");
}

function testGetByNameUndefined() {
  console.log("\n▸ getByName(nonexistent) → undefined");
  const pool = makePool();
  assertEq(pool.getByName("nonexistent"), undefined, "returns undefined");
}

function testIsNameTakenEmpty() {
  console.log("\n▸ isNameTaken on empty pool → false");
  const pool = makePool();
  assertEq(pool.isNameTaken("any"), false, "name not taken");
}

function testListAllEmpty() {
  console.log("\n▸ listAll empty pool → []");
  const pool = makePool();
  assertEq(pool.listAll().length, 0, "empty array");
}

function testClaimPendingProgramUndefined() {
  console.log("\n▸ claimPendingProgram(nonexistent) → undefined");
  const pool = makePool();
  assertEq(pool.claimPendingProgram("nonexistent"), undefined, "returns undefined");
}

function testIsProgramNodeFalse() {
  console.log("\n▸ isProgramNode(nonexistent) → false");
  const pool = makePool();
  assertEq(pool.isProgramNode("nonexistent"), false, "returns false");
}

function testAppendSystemMessageAction() {
  console.log("\n▸ appendSystemMessage stores action in messageStore");
  const pool = makePool();
  const node = {
    id: "parent-1",
    name: "parent",
    messageStore: [],
    appendMessage(msg: any) {
      this.messageStore.push(msg);
    },
  } as any;

  pool.appendSystemMessage(node, "已创建 worker", {
    type: "open_dm",
    nodeId: "child-1",
    nodeName: "worker",
  });

  assertEq(node.messageStore.length, 1, "one system message stored");
  assertEq(node.messageStore[0].role, "system", "role is system");
  assertEq(node.messageStore[0].action, {
    type: "open_dm",
    nodeId: "child-1",
    nodeName: "worker",
  }, "action is preserved");
}

// --- Main ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  NodePool Unit Tests");
  console.log("═══════════════════════════════════════");

  testConstructor();
  testGetUndefined();
  testGetByNameUndefined();
  testIsNameTakenEmpty();
  testListAllEmpty();
  testClaimPendingProgramUndefined();
  testIsProgramNodeFalse();
  testAppendSystemMessageAction();

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
