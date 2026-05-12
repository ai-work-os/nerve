#!/usr/bin/env npx tsx
/**
 * nerve_node_list MCP tool — unit tests (TDD red phase)
 *
 * Tests the filtering/mapping logic for nerve_node_list.
 * The handler in nerve-mcp.ts is inline and calls HTTP — not directly testable.
 *
 * ▸ Coder 需要做的：
 *   1. 从 nerve-mcp.ts 的 nerve_node_list handler 中抽出纯函数：
 *      - filterNodes(nodes, type?, status?) → filtered nodes
 *      - mapNodes(nodes, channelMap) → mapped output
 *   2. 导出这两个函数供测试使用
 *   3. 或者合并为一个 processNodeList(nodes, channelMap, opts) 函数
 *
 * 测试导入路径：../../src/nerve-mcp-node-list.ts（建议抽到独立文件）
 */

// --- Test infrastructure (同 request-handler.test.ts 风格) ---

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

// --- Import under test ---
// 这个模块尚不存在，coder 需要创建它并导出 filterNodes / mapNodes
let filterNodes: (nodes: MockNode[], type?: string, status?: string) => MockNode[];
let mapNodes: (nodes: MockNode[], channelMap: Map<string, string>) => MappedNode[];

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = await import("../../../src/nerve-mcp-node-list.js");
  filterNodes = mod.filterNodes;
  mapNodes = mod.mapNodes;
} catch {
  console.log("⚠ Cannot import nerve-mcp-node-list.ts — module not yet created");
  console.log("  All tests will fail (expected in TDD red phase)\n");
  filterNodes = () => { throw new Error("filterNodes not implemented"); };
  mapNodes = () => { throw new Error("mapNodes not implemented"); };
}

// --- Mock data types ---

interface MockNode {
  id: string;
  name: string;
  status: string;
  commands?: Record<string, { description: string; args?: Record<string, string> }>;
  events?: string[];
  channels: string[];
}

interface MappedNode {
  name: string;
  status: string;
  commands: Record<string, { description: string; args?: Record<string, string> }>;
  events: string[];
  channels: string[];
}

// --- Fixtures ---

const programNode1: MockNode = {
  id: "n1",
  name: "git-tool",
  status: "idle",
  commands: {
    "git.status": { description: "Show git status", args: { path: "repo path" } },
    "git.diff": { description: "Show git diff" },
  },
  events: ["git.changed"],
  channels: ["ch-001", "ch-002"],
};

const programNode2: MockNode = {
  id: "n2",
  name: "file-tool",
  status: "busy",
  commands: {
    "file.read": { description: "Read a file", args: { path: "file path" } },
  },
  events: undefined,
  channels: ["ch-001"],
};

const agentNode1: MockNode = {
  id: "n3",
  name: "coder-agent",
  status: "idle",
  commands: undefined,
  events: undefined,
  channels: ["ch-001"],
};

const agentNode2: MockNode = {
  id: "n4",
  name: "reviewer-agent",
  status: "busy",
  channels: [],
};

const stoppedNode: MockNode = {
  id: "n5",
  name: "old-tool",
  status: "stopped",
  commands: { "old.cmd": { description: "Legacy command" } },
  channels: [],
};

const errorNode: MockNode = {
  id: "n6",
  name: "broken-tool",
  status: "error",
  commands: { "broken.cmd": { description: "Broken command" } },
  channels: ["ch-002"],
};

const allNodes: MockNode[] = [programNode1, programNode2, agentNode1, agentNode2, stoppedNode, errorNode];

const channelMap = new Map<string, string>([
  ["ch-001", "dev-channel"],
  ["ch-002", "review-channel"],
]);

// --- Tests ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  nerve_node_list Tests (TDD Red Phase)");
  console.log("═══════════════════════════════════════");

  // Case 1: 无参数 → 返回全部非 stopped 节点，包含 AI 节点
  console.log("\n▸ Case 1: default (no args) → all non-stopped nodes");
  try {
    const result = filterNodes(allNodes);
    assertEq(result.length, 5, "returns 5 nodes (all except stopped)");
    assert(!result.some(n => n.status === "stopped"), "no stopped nodes");
    assert(result.some(n => n.name === "coder-agent"), "includes agent nodes");
    assert(result.some(n => n.name === "git-tool"), "includes program nodes");
  } catch (e) {
    assert(false, "default filter", String(e));
  }

  // Case 2: type=all → 返回所有节点（不含 stopped）
  console.log("\n▸ Case 2: type=all → all non-stopped nodes");
  try {
    const result = filterNodes(allNodes, "all");
    // 应返回除 stoppedNode 外的所有节点
    assertEq(result.length, 5, "returns 5 nodes (all except stopped)");
    assert(!result.some(n => n.status === "stopped"), "no stopped nodes");
  } catch (e) {
    assert(false, "type=all filter", String(e));
  }

  // Case 3: type=agent → 只返回无 commands 的节点
  console.log("\n▸ Case 3: type=agent → agent nodes only");
  try {
    const result = filterNodes(allNodes, "agent");
    assertEq(result.length, 2, "returns 2 agent nodes");
    assert(result.every(n => !n.commands || Object.keys(n.commands).length === 0), "none have commands");
    assert(result.some(n => n.name === "coder-agent"), "includes coder-agent");
    assert(result.some(n => n.name === "reviewer-agent"), "includes reviewer-agent");
  } catch (e) {
    assert(false, "type=agent filter", String(e));
  }

  // Case 4: status=idle → 只返回 idle 节点
  console.log("\n▸ Case 4: status=idle → idle nodes only");
  try {
    const result = filterNodes(allNodes, "program", "idle");
    // program + idle = 只有 programNode1
    assertEq(result.length, 1, "returns 1 idle program node");
    assertEq(result[0].name, "git-tool", "is git-tool");
  } catch (e) {
    assert(false, "status=idle filter", String(e));
  }

  // Case 5: stopped 节点默认不返回
  console.log("\n▸ Case 5: stopped nodes excluded by default");
  try {
    const result = filterNodes(allNodes);
    assert(!result.some(n => n.status === "stopped"), "no stopped in default");
    // 但指定 status=stopped 可以查到
    const stoppedResult = filterNodes(allNodes, "program", "stopped");
    assertEq(stoppedResult.length, 1, "status=stopped returns stopped program node");
    assertEq(stoppedResult[0].name, "old-tool", "is old-tool");
  } catch (e) {
    assert(false, "stopped exclusion", String(e));
  }

  // Case 6: 无节点时返回空数组
  console.log("\n▸ Case 6: empty nodes → empty result");
  try {
    const result = filterNodes([]);
    assertEq(result.length, 0, "returns 0 nodes");
  } catch (e) {
    assert(false, "empty nodes", String(e));
  }

  // Case 7: channels 字段是名称而非 ID（mapNodes 测试）
  console.log("\n▸ Case 7: channels mapped to names");
  try {
    const mapped = mapNodes([programNode1], channelMap);
    assertEq(mapped[0].channels, ["dev-channel", "review-channel"], "channel IDs → names");
  } catch (e) {
    assert(false, "channel name mapping", String(e));
  }

  // Case 7b: channel ID 无法映射时 fallback 原始 ID
  console.log("\n▸ Case 7b: unknown channel ID falls back to raw ID");
  try {
    const nodeWithUnknownChannel: MockNode = {
      id: "nx", name: "test", status: "idle",
      commands: { x: { description: "x" } },
      channels: ["ch-999"],
    };
    const mapped = mapNodes([nodeWithUnknownChannel], channelMap);
    assertEq(mapped[0].channels, ["ch-999"], "unknown channel ID preserved");
  } catch (e) {
    assert(false, "channel fallback", String(e));
  }

  // Case 8: commands/events 为 undefined 时返回空对象/空数组
  console.log("\n▸ Case 8: undefined commands/events → empty defaults");
  try {
    const mapped = mapNodes([agentNode1], channelMap);
    assertEq(mapped[0].commands, {}, "undefined commands → {}");
    assertEq(mapped[0].events, [], "undefined events → []");
  } catch (e) {
    assert(false, "undefined defaults", String(e));
  }

  // Case 8b: programNode2 events is undefined
  console.log("\n▸ Case 8b: programNode2 events undefined → []");
  try {
    const mapped = mapNodes([programNode2], channelMap);
    assertEq(mapped[0].events, [], "events undefined → []");
    assert(Object.keys(mapped[0].commands).length > 0, "commands preserved");
  } catch (e) {
    assert(false, "programNode2 defaults", String(e));
  }

  // Summary
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
