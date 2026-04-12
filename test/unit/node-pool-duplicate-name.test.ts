#!/usr/bin/env npx tsx
/**
 * NodePool duplicate name rejection tests
 *
 * Verifies that _spawnProcess and registerWebSocket reject duplicate names
 * at the node-pool level (not just http-router).
 *
 * Run: npx tsx test/unit/node-pool-duplicate-name.test.ts
 */

import { NodePool } from "../../src/node-pool.js";
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

const noopStore = {
  insertNode() {},
  updateNodeStatus() {},
} as any;

function createPool(): NodePool {
  return new NodePool(noopStore, () => {});
}

/** Register a node directly into pool internals (simulates existing node) */
function seedNode(pool: NodePool, name: string): void {
  const p = pool as any;
  const id = `seed-${name}-${Date.now()}`;
  const node = new NerveNode({
    id,
    name,
    transport: { alive: true, close() {}, onClose() {}, send() {} } as any,
    capabilities: ["code"],
  });
  node.status = "idle";
  p.nodes.set(id, node);
  p.nameIndex.set(name, id);
}

function createMockWs(): any {
  return {
    on() {},
    once() {},
    send() {},
    close() {},
    readyState: 1,
    addEventListener() {},
    removeEventListener() {},
  };
}

// --- Tests ---

function testRegisterWebSocketDuplicateNameThrows() {
  console.log("\n▸ registerWebSocket: duplicate name throws");
  const pool = createPool();
  seedNode(pool, "my-agent");

  let threw = false;
  let errorMsg = "";
  try {
    pool.registerWebSocket(createMockWs(), "my-agent", ["ui"], "full");
  } catch (e: any) {
    threw = true;
    errorMsg = e.message;
  }

  assert(threw, "registerWebSocket throws on duplicate name");
  assert(errorMsg.includes("already taken"), `error message includes 'already taken': ${errorMsg}`);
}

function testRegisterWebSocketUniqueNameSucceeds() {
  console.log("\n▸ registerWebSocket: unique name succeeds");
  const pool = createPool();
  seedNode(pool, "existing-agent");

  let threw = false;
  try {
    pool.registerWebSocket(createMockWs(), "new-agent", ["ui"], "full");
  } catch {
    threw = true;
  }

  assert(!threw, "registerWebSocket succeeds with unique name");
  assert(pool.isNameTaken("new-agent"), "new name registered in nameIndex");
}

function testSpawnProcessDuplicateNameThrows() {
  console.log("\n▸ spawnProcessSync: duplicate name throws");
  const pool = createPool();
  seedNode(pool, "coder");

  let threw = false;
  let errorMsg = "";
  try {
    pool.spawnProcessSync("mock", "coder", "/tmp", 4899);
  } catch (e: any) {
    threw = true;
    errorMsg = e.message;
  }

  assert(threw, "spawnProcessSync throws on duplicate name");
  // Could be "already taken" or "unknown adapter" — we want "already taken" to come first
  assert(errorMsg.includes("already taken"), `error is about name conflict, not adapter: ${errorMsg}`);
}

function testStopThenReuseNameSucceeds() {
  console.log("\n▸ stop → re-register same name succeeds");
  const pool = createPool();
  const ws = createMockWs();
  const node = pool.registerWebSocket(ws, "reuse-me", ["ui"], "full");

  // Remove the node (simulates stop + cleanup)
  pool.remove(node.id);
  assert(!pool.isNameTaken("reuse-me"), "name freed after remove");

  // Re-register with same name should work
  let threw = false;
  try {
    pool.registerWebSocket(createMockWs(), "reuse-me", ["ui"], "full");
  } catch {
    threw = true;
  }
  assert(!threw, "re-register same name after remove succeeds");
}

// --- Main ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  NodePool Duplicate Name Tests");
  console.log("═══════════════════════════════════════");

  testRegisterWebSocketDuplicateNameThrows();
  testRegisterWebSocketUniqueNameSucceeds();
  testSpawnProcessDuplicateNameThrows();
  testStopThenReuseNameSucceeds();

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
