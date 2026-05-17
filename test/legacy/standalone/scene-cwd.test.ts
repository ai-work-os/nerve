#!/usr/bin/env npx tsx
/**
 * SceneConfig.cwd — unit tests (TDD)
 *
 * Tests:
 * 1. scene config with cwd → spawnNode receives config.cwd (takes priority)
 * 2. scene config without cwd, start() given cwd → falls back to start() cwd
 * 3. scene config without cwd, no start() cwd → falls back to process.cwd()
 * 4. config.cwd overrides start() cwd (priority: config > start param)
 *
 * Approach: mock ChannelManager, capture spawnNode(adapter, name, cwd) calls.
 * isNameTaken returns false so spawnNode is always invoked (not the reuse path).
 */

import type { SceneConfig } from "../../../src/scene/scene-manager.js";
import { SceneManager } from "../../../src/scene/scene-manager.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Test infrastructure ---

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

// --- Mock helpers ---

interface MockNode {
  id: string;
  name: string;
  isProcess: boolean;
  sessionId?: string;
  transport: { alive: boolean; type: string; send: (msg: any) => void };
  channels: Set<string>;
}

function createMockNode(id: string, name: string): MockNode {
  return {
    id,
    name,
    isProcess: true,
    sessionId: "sess-" + id,
    transport: {
      alive: true,
      type: "stdio",
      send: () => {},
    },
    channels: new Set(),
  };
}

type CallRecord = { method: string; args: any[] };

/**
 * Create a mock ChannelManager where:
 * - isNameTaken always returns false → SceneManager will always call spawnNode
 * - spawnNode records calls and returns the node from the provided list by name
 * - getByName is only used post-spawn (e.g. on_ready), returns from the map
 */
function createMockCm(nodes: MockNode[]) {
  const calls: CallRecord[] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const nameMap = new Map(nodes.map(n => [n.name, n]));

  const nodePool = {
    get(id: string) { return nodeMap.get(id); },
    getByName(name: string) { return nameMap.get(name); },
    // Always return false: force SceneManager to call spawnNode, not the reuse path
    isNameTaken(_name: string) { return false; },
    async promptNode(_nodeId: string, _text: string) {
      return { stopReason: "end_turn" };
    },
  };

  return {
    calls,
    nodePool,
    addNodeToChannel(channelId: string, nodeId: string, nodeName: string) {
      calls.push({ method: "addNodeToChannel", args: [channelId, nodeId, nodeName] });
    },
    spawnNode: async (adapter: string, name: string, cwd: string) => {
      const node = nameMap.get(name);
      if (!node) throw new Error(`mock: node "${name}" not found in mock pool`);
      calls.push({ method: "spawnNode", args: [adapter, name, cwd] });
      return node;
    },
    stopNode(id: string) {
      calls.push({ method: "stopNode", args: [id] });
    },
    createChannel(cwd: string, name?: string) {
      calls.push({ method: "createChannel", args: [cwd, name] });
      return { id: "ch-mock", name: name || "test" };
    },
    listChannels() { return []; },
    closeChannel(id: string) {
      calls.push({ method: "closeChannel", args: [id] });
    },
    onNodeEvent: undefined as any,
  };
}

// --- Tests ---

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  SceneConfig.cwd Tests");
  console.log("  (TDD — config.cwd priority)");
  console.log("═══════════════════════════════════════════════");

  // --- Test 1: config.cwd present → spawnNode uses config.cwd ---
  console.log("\n▸ Test 1: config.cwd set → spawnNode receives config.cwd");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-cwd-test-"));
    const agentNode = createMockNode("n1", "agent");
    const cm = createMockCm([agentNode]);

    // Create SceneManager first (constructor creates scenes dir)
    const sm = new SceneManager(cm as any, dataDir);

    const config: SceneConfig = {
      name: "test-config-cwd",
      cwd: "/my/project/path",
      nodes: [{ adapter: "claude", name: "agent" }],
    };
    writeFileSync(join(dataDir, "scenes", "test-config-cwd.json"), JSON.stringify(config));

    await sm.start("test-config-cwd", "/start-param-cwd");
    await new Promise(r => setTimeout(r, 100));

    const spawnCalls = cm.calls.filter(c => c.method === "spawnNode");
    assert(spawnCalls.length === 1, "spawnNode called once");
    if (spawnCalls.length === 1) {
      assertEq(spawnCalls[0].args[2], "/my/project/path", "spawnNode receives config.cwd");
    }

    await sm.stop("test-config-cwd");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 2: config.cwd absent, start() cwd given → spawnNode uses start() cwd ---
  console.log("\n▸ Test 2: no config.cwd → falls back to start() cwd param");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-cwd-test-"));
    const agentNode = createMockNode("n1", "agent");
    const cm = createMockCm([agentNode]);

    const sm = new SceneManager(cm as any, dataDir);

    const config: SceneConfig = {
      name: "test-no-config-cwd",
      // no cwd field
      nodes: [{ adapter: "claude", name: "agent" }],
    };
    writeFileSync(join(dataDir, "scenes", "test-no-config-cwd.json"), JSON.stringify(config));

    await sm.start("test-no-config-cwd", "/start-param-cwd");
    await new Promise(r => setTimeout(r, 100));

    const spawnCalls = cm.calls.filter(c => c.method === "spawnNode");
    assert(spawnCalls.length === 1, "spawnNode called once");
    if (spawnCalls.length === 1) {
      assertEq(spawnCalls[0].args[2], "/start-param-cwd", "spawnNode receives start() cwd param");
    }

    await sm.stop("test-no-config-cwd");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 3: no config.cwd and no start() cwd → falls back to process.cwd() ---
  console.log("\n▸ Test 3: no config.cwd, no start() cwd → falls back to process.cwd()");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-cwd-test-"));
    const agentNode = createMockNode("n1", "agent");
    const cm = createMockCm([agentNode]);

    const sm = new SceneManager(cm as any, dataDir);

    const config: SceneConfig = {
      name: "test-fallback-cwd",
      // no cwd field
      nodes: [{ adapter: "claude", name: "agent" }],
    };
    writeFileSync(join(dataDir, "scenes", "test-fallback-cwd.json"), JSON.stringify(config));

    await sm.start("test-fallback-cwd"); // no cwd param
    await new Promise(r => setTimeout(r, 100));

    const spawnCalls = cm.calls.filter(c => c.method === "spawnNode");
    assert(spawnCalls.length === 1, "spawnNode called once");
    if (spawnCalls.length === 1) {
      assertEq(spawnCalls[0].args[2], process.cwd(), "spawnNode receives process.cwd()");
    }

    await sm.stop("test-fallback-cwd");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 4: config.cwd overrides start() cwd (priority: config > start param) ---
  console.log("\n▸ Test 4: config.cwd overrides start() cwd (priority check)");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-cwd-test-"));
    const agentNode = createMockNode("n1", "agent");
    const cm = createMockCm([agentNode]);

    const sm = new SceneManager(cm as any, dataDir);

    const config: SceneConfig = {
      name: "test-priority-cwd",
      cwd: "/config-wins",
      nodes: [{ adapter: "claude", name: "agent" }],
    };
    writeFileSync(join(dataDir, "scenes", "test-priority-cwd.json"), JSON.stringify(config));

    // start() is given a different cwd — config.cwd must win
    await sm.start("test-priority-cwd", "/param-loses");
    await new Promise(r => setTimeout(r, 100));

    const spawnCalls = cm.calls.filter(c => c.method === "spawnNode");
    assert(spawnCalls.length === 1, "spawnNode called once");
    if (spawnCalls.length === 1) {
      assertEq(spawnCalls[0].args[2], "/config-wins", "config.cwd wins over start() cwd");
      assert(spawnCalls[0].args[2] !== "/param-loses", "start() cwd is NOT used when config.cwd is set");
    }

    await sm.stop("test-priority-cwd");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════

  console.log("\n══════════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("══════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
