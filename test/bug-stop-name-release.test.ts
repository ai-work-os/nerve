/**
 * Bug: stop/remove 后 nameIndex 未清理，相同名字无法重新 spawn
 *
 * 复现：spawn("reviewer") → stop → spawn("reviewer") 报 name already taken
 * 根因：stopNode() 不清理 nameIndex，ACP node onClose 也不调 remove()
 *
 * 测试用例：
 * 1. spawn → stop → re-spawn 同名应成功（含 getByName 验证新 node）
 * 2. spawn → remove → re-spawn 同名应成功
 * 3. spawn → stop → remove → re-spawn 同名应成功
 * 4. isNameTaken 在 stop 后应返回 false
 * 5. 重名 spawn 应报 "name already taken"（确认守卫逻辑正常）
 * 6. stop 后 onClose 回调不触发 remove 时，nameIndex 仍应被清理
 *
 * 运行: npx tsx test/bug-stop-name-release.test.ts
 */

import { NodePool } from "../src/node-pool.js";
import { NerveNode } from "../src/node.js";

// --- Minimal mock store ---
const noopStore = {
  insertNode() {},
  updateNodeStatus() {},
} as any;

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

// --- Helper: create pool + register node with realistic transport ---

function createPool(): NodePool {
  return new NodePool(noopStore, () => {});
}

/** 模拟 server.ts 的 spawn 流程：检查重名 → 注册 node → 返回 id */
function trySpawn(pool: NodePool, name: string): { ok: boolean; id?: string; error?: string } {
  if (pool.isNameTaken(name)) {
    return { ok: false, error: `name "${name}" already taken` };
  }
  const id = registerNode(pool, name);
  return { ok: true, id };
}

/** 注册一个带 onClose 回调的 mock node（模拟 ACP stdio node） */
function registerNode(pool: NodePool, name: string): string {
  const p = pool as any;
  const id = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let onCloseHandler: ((code?: number) => void) | null = null;
  const fakeTransport = {
    alive: true,
    close() {
      this.alive = false;
      // 模拟 StdioTransport.close: 异步触发 onClose
      if (onCloseHandler) onCloseHandler(0);
    },
    onClose(fn: (code?: number) => void) { onCloseHandler = fn; },
    send() {},
  };
  const node = new NerveNode({
    id,
    name,
    transport: fakeTransport as any,
    capabilities: ["code"],
    adapter: "mock",
    cwd: "/tmp",
  });
  node.status = "idle";
  p.nodes.set(id, node);
  p.nameIndex.set(name, id);
  return id;
}

// --- Tests ---

async function testStopThenRespawn() {
  console.log("\n▸ T4-1: spawn → stop → re-spawn same name");

  const pool = createPool();
  const r1 = trySpawn(pool, "reviewer");
  assert(r1.ok, "first spawn succeeds");

  pool.stopNode(r1.id!);

  // 关键：stop 后用 trySpawn 走完整 isNameTaken 守卫
  const r2 = trySpawn(pool, "reviewer");
  assert(r2.ok, "re-spawn same name after stop succeeds",
    r2.ok ? undefined : r2.error);

  // 验证新 node 是独立的
  assert(r2.id !== r1.id, "new node has different id");
  const node = pool.getByName("reviewer");
  assert(node?.id === r2.id, "getByName returns new node, not stale one");
}

async function testRemoveThenRespawn() {
  console.log("\n▸ T4-2: spawn → remove → re-spawn same name");

  const pool = createPool();
  const r1 = trySpawn(pool, "reviewer");
  assert(r1.ok, "first spawn succeeds");

  pool.remove(r1.id!);

  const r2 = trySpawn(pool, "reviewer");
  assert(r2.ok, "re-spawn same name after remove succeeds",
    r2.ok ? undefined : r2.error);
  assert(!!pool.get(r2.id!), "new node exists in pool");
}

async function testStopRemoveThenRespawn() {
  console.log("\n▸ T4-3: spawn → stop → remove → re-spawn same name");

  const pool = createPool();
  const r1 = trySpawn(pool, "reviewer");
  assert(r1.ok, "first spawn succeeds");

  pool.stopNode(r1.id!);
  pool.remove(r1.id!);

  const r2 = trySpawn(pool, "reviewer");
  assert(r2.ok, "re-spawn same name after stop+remove succeeds",
    r2.ok ? undefined : r2.error);
}

async function testIsNameTakenAfterStop() {
  console.log("\n▸ T4-4: isNameTaken returns false after stop");

  const pool = createPool();
  const r1 = trySpawn(pool, "checker");
  assert(r1.ok && pool.isNameTaken("checker"), "isNameTaken=true before stop");

  pool.stopNode(r1.id!);

  assert(!pool.isNameTaken("checker"), "isNameTaken=false after stop",
    pool.isNameTaken("checker") ? "BUG: nameIndex still has entry after stopNode" : undefined);
}

async function testDuplicateNameBlocked() {
  console.log("\n▸ T4-5: duplicate name spawn returns error");

  const pool = createPool();
  const r1 = trySpawn(pool, "reviewer");
  assert(r1.ok, "first spawn succeeds");

  // 不 stop，直接再 spawn 同名
  const r2 = trySpawn(pool, "reviewer");
  assert(!r2.ok, "duplicate name spawn blocked");
  assert(r2.error === 'name "reviewer" already taken', "error message matches",
    r2.error !== 'name "reviewer" already taken' ? `got: ${r2.error}` : undefined);

  // 原 node 不受影响
  assert(pool.getByName("reviewer")?.id === r1.id, "original node unchanged");
}

async function testOnCloseWithoutRemove() {
  console.log("\n▸ T4-6: stop triggers onClose but onClose doesn't call remove — nameIndex should still be cleaned");

  // 模拟真实场景：ACP node 的 onClose 只设 status=stopped，不调 remove()
  const events: string[] = [];
  const pool = new NodePool(noopStore, (event) => { events.push(event); });
  const p = pool as any;

  const id = `test-onclose-${Date.now()}`;
  let onCloseHandler: ((code?: number) => void) | null = null;
  const fakeTransport = {
    alive: true,
    close() {
      this.alive = false;
      // 模拟 ACP node 的 onClose：只改 status，不调 remove
      if (onCloseHandler) onCloseHandler(0);
    },
    onClose(fn: (code?: number) => void) { onCloseHandler = fn; },
    send() {},
  };
  const node = new NerveNode({
    id,
    name: "agent-x",
    transport: fakeTransport as any,
    capabilities: ["code"],
    adapter: "mock",
    cwd: "/tmp",
  });
  node.status = "idle";
  p.nodes.set(id, node);
  p.nameIndex.set("agent-x", id);

  assert(pool.isNameTaken("agent-x"), "name taken before stop");

  // stopNode → transport.close() → onClose fires (但不调 remove)
  pool.stopNode(id);

  // 即使 onClose 没调 remove，stopNode 自身应该清 nameIndex
  assert(!pool.isNameTaken("agent-x"), "nameIndex cleaned by stopNode even without remove",
    pool.isNameTaken("agent-x") ? "BUG: stopNode relies on onClose→remove to clean nameIndex, but ACP onClose doesn't call remove" : undefined);

  // 验证可以重新 spawn
  const r = trySpawn(pool, "agent-x");
  assert(r.ok, "re-spawn after onClose-without-remove succeeds",
    r.ok ? undefined : r.error);
}

// --- Main ---

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  T4: stop name release bug test      ║");
  console.log("╚══════════════════════════════════════╝");

  await testStopThenRespawn();
  await testRemoveThenRespawn();
  await testStopRemoveThenRespawn();
  await testIsNameTakenAfterStop();
  await testDuplicateNameBlocked();
  await testOnCloseWithoutRemove();

  console.log("\n" + "═".repeat(40));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
