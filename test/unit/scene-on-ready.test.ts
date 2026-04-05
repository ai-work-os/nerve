#!/usr/bin/env npx tsx
/**
 * Scene on_ready & prompt injection — unit tests (TDD red phase)
 *
 * Tests:
 * P0-1: on_ready sequential execution
 * P0-2: SceneNodeDef.prompt injection into node.systemPrompt
 * Integration: subscribe before start ordering
 *
 * Test approach: mock ChannelManager and NodePool to verify
 * call ordering and prompt injection without real nodes.
 */

import type { SceneConfig, SceneNodeDef, SceneOnReady } from "../../src/scene-manager.js";

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
  systemPrompt?: string;
  isProcess: boolean;
  sessionId?: string;
  transport: { alive: boolean; type: string; send: (msg: any) => void };
  channels: Set<string>;
}

function createMockNode(id: string, name: string, opts?: { isProcess?: boolean; systemPrompt?: string }): MockNode {
  return {
    id,
    name,
    systemPrompt: opts?.systemPrompt,
    isProcess: opts?.isProcess ?? false,
    sessionId: opts?.isProcess ? "sess-" + id : undefined,
    transport: {
      alive: true,
      type: opts?.isProcess ? "stdio" : "websocket",
      send: () => {},
    },
    channels: new Set(),
  };
}

/** Track call order across mock methods */
type CallRecord = { method: string; args: any[] };

function createMockCm(nodes: MockNode[]) {
  const calls: CallRecord[] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const nameMap = new Map(nodes.map(n => [n.name, n]));

  // Concurrency tracking for promptNode
  let concurrency = 0;
  let maxConcurrency = 0;

  const nodePool = {
    get(id: string) { return nodeMap.get(id); },
    getByName(name: string) { return nameMap.get(name); },
    isNameTaken(name: string) { return nameMap.has(name); },
    async promptNode(nodeId: string, text: string) {
      concurrency++;
      if (concurrency > maxConcurrency) maxConcurrency = concurrency;
      calls.push({ method: "promptNode", args: [nodeId, text] });
      // Simulate async work — long enough that parallel calls would overlap
      await new Promise(r => setTimeout(r, 50));
      concurrency--;
      return { stopReason: "end_turn" };
    },
  };

  return {
    calls,
    nodePool,
    get maxConcurrency() { return maxConcurrency; },
    addNodeToChannel(channelId: string, nodeId: string, nodeName: string) {
      calls.push({ method: "addNodeToChannel", args: [channelId, nodeId, nodeName] });
    },
    spawnNode: async (adapter: string, name: string, cwd: string) => {
      const node = nameMap.get(name);
      if (!node) throw new Error(`mock: node ${name} not found`);
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

// --- Import SceneManager ---

import { SceneManager } from "../../src/scene-manager.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Tests ---

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Scene on_ready & Prompt Injection Tests");
  console.log("  (TDD Red Phase)");
  console.log("═══════════════════════════════════════════════");

  // ══════════════════════════════════════════════════
  // P0-1: on_ready sequential execution
  // ══════════════════════════════════════════════════

  // --- Test 1: on_ready commands execute sequentially ---
  console.log("\n▸ Test 1: on_ready commands execute sequentially (not parallel)");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const mcNode = createMockNode("n1", "mc", { isProcess: true });
    const analystNode = createMockNode("n2", "analyst", { isProcess: true });
    const cm = createMockCm([mcNode, analystNode]);

    const sm = new SceneManager(cm as any, dataDir);

    const config: SceneConfig = {
      name: "test-seq",
      nodes: [
        { adapter: "mc", name: "mc" },
        { adapter: "claude", name: "analyst" },
      ],
      channel: { name: "test-ch", auto_create: true },
      on_ready: [
        { to: "mc", command: "subscribe", target: "analyst" },
        { to: "mc", command: "start" },
      ],
    };
    writeFileSync(join(dataDir, "scenes", "test-seq.json"), JSON.stringify(config));
    const scene = await sm.start("test-seq", "/tmp");

    // Wait for async executeOnReady to complete
    await new Promise(r => setTimeout(r, 200));

    // Filter promptNode calls — they should be in order
    const promptCalls = cm.calls.filter(c => c.method === "promptNode");
    assert(promptCalls.length === 2, "two promptNode calls");

    if (promptCalls.length === 2) {
      // First call: subscribe analyst
      assert(
        promptCalls[0].args[1] === "subscribe analyst",
        "first on_ready: subscribe analyst",
        `got: ${promptCalls[0].args[1]}`,
      );
      // Second call: start
      assert(
        promptCalls[1].args[1] === "start",
        "second on_ready: start",
        `got: ${promptCalls[1].args[1]}`,
      );

    }

    // Key assertion: maxConcurrency must be 1 (sequential, not parallel)
    // With Promise.all + 50ms delay, both would run concurrently → maxConcurrency=2
    // With for...of, only one runs at a time → maxConcurrency=1
    assertEq(cm.maxConcurrency, 1, "maxConcurrency === 1 (proves sequential execution)");

    await sm.stop("test-seq");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 2: on_ready target not found → skip with warning ---
  console.log("\n▸ Test 2: on_ready target not found → skip with warning, continue");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const mcNode = createMockNode("n1", "mc", { isProcess: true });
    const cm = createMockCm([mcNode]);

    const config: SceneConfig = {
      name: "test-missing",
      nodes: [{ adapter: "mc", name: "mc" }],
      channel: { name: "test-ch", auto_create: true },
      on_ready: [
        { to: "ghost", command: "subscribe", target: "analyst" }, // ghost doesn't exist
        { to: "mc", command: "start" }, // should still execute
      ],
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "test-missing.json"),
      JSON.stringify(config),
    );
    const scene = await sm.start("test-missing", "/tmp");
    await new Promise(r => setTimeout(r, 200));

    // "ghost" should be skipped, "mc start" should still execute
    const promptCalls = cm.calls.filter(c => c.method === "promptNode");
    assert(promptCalls.length === 1, "only one promptNode call (ghost skipped)");
    if (promptCalls.length === 1) {
      assertEq(promptCalls[0].args[1], "start", "mc start still executed");
    }

    // Scene should have a warning about ghost
    const runningScene = sm.get("test-missing");
    assert(!!runningScene?.warnings, "scene has warnings");
    if (runningScene?.warnings) {
      assert(
        runningScene.warnings.some(w => w.includes("ghost") && w.includes("not found")),
        "warning mentions ghost not found",
      );
    }

    await sm.stop("test-missing");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 3: on_ready target not ready → skip with warning ---
  console.log("\n▸ Test 3: on_ready target not ready → skip with warning");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const mcNode = createMockNode("n1", "mc", { isProcess: true });
    // analyst exists but won't become ready (transport not alive, no sessionId)
    const analystNode = createMockNode("n2", "analyst", { isProcess: true });
    analystNode.transport.alive = false;
    analystNode.sessionId = undefined;
    const cm = createMockCm([mcNode, analystNode]);

    const config: SceneConfig = {
      name: "test-notready",
      nodes: [
        { adapter: "mc", name: "mc" },
        { adapter: "claude", name: "analyst" },
      ],
      channel: { name: "test-ch", auto_create: true },
      on_ready: [
        { to: "analyst", command: "analyze", prompt: true }, // analyst not ready
        { to: "mc", command: "start" }, // mc is ready, should execute
      ],
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "test-notready.json"),
      JSON.stringify(config),
    );
    const scene = await sm.start("test-notready", "/tmp");

    // waitForReady will timeout for analyst; give enough time
    await new Promise(r => setTimeout(r, 12000));

    const promptCalls = cm.calls.filter(c => c.method === "promptNode");
    // analyst should be skipped (not ready), mc start should execute
    assert(promptCalls.length === 1, "only mc prompted (analyst skipped as not ready)");
    if (promptCalls.length === 1) {
      assertEq(promptCalls[0].args[1], "start", "mc start executed");
    }

    const runningScene = sm.get("test-notready");
    assert(!!runningScene?.warnings, "scene has warnings about not-ready");
    if (runningScene?.warnings) {
      assert(
        runningScene.warnings.some(w => w.includes("analyst") && w.includes("not ready")),
        "warning mentions analyst not ready",
      );
    }

    await sm.stop("test-notready");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════
  // P0-2: SceneNodeDef.prompt injection
  // ══════════════════════════════════════════════════

  // --- Test 4: nodeDef with prompt → appended to node.systemPrompt ---
  console.log("\n▸ Test 4: nodeDef.prompt → appended to node.systemPrompt");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const analystNode = createMockNode("n1", "analyst", {
      isProcess: true,
      systemPrompt: "base system prompt",
    });
    const cm = createMockCm([analystNode]);

    const config: SceneConfig = {
      name: "test-prompt-inject",
      nodes: [
        {
          adapter: "claude",
          name: "analyst",
          prompt: "你是会议分析助手",
        } as SceneNodeDef,
      ],
      channel: { name: "test-ch", auto_create: true },
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "test-prompt-inject.json"),
      JSON.stringify(config),
    );
    await sm.start("test-prompt-inject", "/tmp");
    await new Promise(r => setTimeout(r, 200));

    // After scene start, analyst's systemPrompt should have the role prompt appended
    assert(
      analystNode.systemPrompt?.includes("你是会议分析助手") === true,
      "role prompt appended to systemPrompt",
      `got: ${analystNode.systemPrompt}`,
    );
    assert(
      analystNode.systemPrompt?.startsWith("base system prompt") === true,
      "original systemPrompt preserved",
      `got: ${analystNode.systemPrompt}`,
    );
    // Should be joined with \n\n
    assert(
      analystNode.systemPrompt === "base system prompt\n\n你是会议分析助手",
      "joined with double newline",
      `got: ${analystNode.systemPrompt}`,
    );

    await sm.stop("test-prompt-inject");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 5: nodeDef without prompt → systemPrompt unchanged ---
  console.log("\n▸ Test 5: nodeDef without prompt → systemPrompt unchanged");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const mcNode = createMockNode("n1", "mc", {
      isProcess: true,
      systemPrompt: "original prompt",
    });
    const cm = createMockCm([mcNode]);

    const config: SceneConfig = {
      name: "test-no-prompt",
      nodes: [{ adapter: "mc", name: "mc" }], // no prompt field
      channel: { name: "test-ch", auto_create: true },
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "test-no-prompt.json"),
      JSON.stringify(config),
    );
    await sm.start("test-no-prompt", "/tmp");
    await new Promise(r => setTimeout(r, 200));

    assertEq(mcNode.systemPrompt, "original prompt", "systemPrompt unchanged");

    await sm.stop("test-no-prompt");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Test 6: multiple nodes each with own prompt → independent injection ---
  console.log("\n▸ Test 6: multiple nodes with prompts → each independently injected");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const node1 = createMockNode("n1", "analyst", {
      isProcess: true,
      systemPrompt: "base-analyst",
    });
    const node2 = createMockNode("n2", "reviewer", {
      isProcess: true,
      systemPrompt: "base-reviewer",
    });
    const cm = createMockCm([node1, node2]);

    const config: SceneConfig = {
      name: "test-multi-prompt",
      nodes: [
        { adapter: "claude", name: "analyst", prompt: "analyze meetings" } as SceneNodeDef,
        { adapter: "claude", name: "reviewer", prompt: "review code" } as SceneNodeDef,
      ],
      channel: { name: "test-ch", auto_create: true },
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "test-multi-prompt.json"),
      JSON.stringify(config),
    );
    await sm.start("test-multi-prompt", "/tmp");
    await new Promise(r => setTimeout(r, 200));

    assertEq(
      node1.systemPrompt,
      "base-analyst\n\nanalyze meetings",
      "analyst got its own prompt",
    );
    assertEq(
      node2.systemPrompt,
      "base-reviewer\n\nreview code",
      "reviewer got its own prompt",
    );

    await sm.stop("test-multi-prompt");
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════
  // Integration: subscribe before start
  // ══════════════════════════════════════════════════

  // --- Test 7: meeting scene — subscribe executes before start ---
  console.log("\n▸ Test 7: meeting scene — subscribe before start (call order)");
  {
    const dataDir = mkdtempSync(join(tmpdir(), "nerve-scene-test-"));
    const mcNode = createMockNode("n1", "mc", { isProcess: true });
    const analystNode = createMockNode("n2", "analyst", { isProcess: true });
    const cm = createMockCm([mcNode, analystNode]);

    // Simulate meeting.json config
    const config: SceneConfig = {
      name: "meeting",
      nodes: [
        { adapter: "mc", name: "mc" },
        { adapter: "claude", name: "analyst", prompt: "你是会议分析助手" } as SceneNodeDef,
      ],
      channel: { name: "meeting", auto_create: true },
      on_ready: [
        { to: "mc", command: "subscribe", target: "analyst" },
        { to: "mc", command: "start" },
      ],
    };
    const sm = new SceneManager(cm as any, dataDir);
    writeFileSync(
      join(dataDir, "scenes", "meeting.json"),
      JSON.stringify(config),
    );
    await sm.start("meeting", "/tmp");
    await new Promise(r => setTimeout(r, 200));

    // Verify call order: addNodeToChannel calls first, then promptNode calls
    const promptCalls = cm.calls.filter(c => c.method === "promptNode");
    assert(promptCalls.length === 2, "two on_ready commands executed");

    if (promptCalls.length === 2) {
      const subscribeIdx = cm.calls.findIndex(
        c => c.method === "promptNode" && c.args[1] === "subscribe analyst",
      );
      const startIdx = cm.calls.findIndex(
        c => c.method === "promptNode" && c.args[1] === "start",
      );
      assert(subscribeIdx >= 0, "subscribe call found");
      assert(startIdx >= 0, "start call found");
      assert(
        subscribeIdx < startIdx,
        "subscribe executed before start",
        `subscribe at index ${subscribeIdx}, start at index ${startIdx}`,
      );
    }

    // Sequential execution proof
    assertEq(cm.maxConcurrency, 1, "maxConcurrency === 1 (sequential execution)");

    await sm.stop("meeting");
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
