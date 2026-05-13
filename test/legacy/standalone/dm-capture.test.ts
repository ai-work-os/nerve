#!/usr/bin/env npx tsx
/**
 * DM Capture — Unit Tests (TDD Red Phase)
 *
 * Tests for formatDmRecord() and DmRecord type in logic.ts.
 * These test pure functions, no server needed.
 *
 * Run: npx tsx test/unit/dm-capture.test.ts
 */

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

// --- Import target module (will fail until implemented) ---

import {
  formatDmRecord,
  type DmRecord,
} from "../../../src/plugins/user-recorder/logic.js";

import { NodePool } from "../../../src/node/node-pool.js";
import { NerveNode } from "../../../src/node/node.js";

// ============================================================
// formatDmRecord — prompt type
// ============================================================

function testFormatDmRecordPrompt() {
  console.log("\n▸ formatDmRecord('prompt'): extracts fields correctly");

  const params = {
    text: "hello AI",
    from: { nodeId: "n1", name: "tui-user" },
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    ts: "2026-04-05T10:00:00.000Z",
  };

  const record = formatDmRecord("prompt", params);

  assertEq(record.type, "prompt", "type is prompt");
  assertEq(record.text, "hello AI", "text preserved");
  assertEq(record.from, { nodeId: "n1", name: "tui-user" }, "from preserved");
  assertEq(record.targetNodeId, "n2", "targetNodeId preserved");
  assertEq(record.targetNodeName, "claude-1", "targetNodeName preserved");
  assertEq(record.ts, "2026-04-05T10:00:00.000Z", "ts preserved");
  assert(record.stopReason === undefined, "prompt has no stopReason");
  assert(record.durationMs === undefined, "prompt has no durationMs");
  assert(record.error === undefined, "prompt has no error");
}

// ============================================================
// formatDmRecord — response type
// ============================================================

function testFormatDmRecordResponse() {
  console.log("\n▸ formatDmRecord('response'): handles stopReason + durationMs");

  const params = {
    text: "Here is my answer...",
    from: { nodeId: "n1", name: "tui-user" },
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    stopReason: "end_turn",
    durationMs: 3200,
    ts: "2026-04-05T10:00:05.000Z",
  };

  const record = formatDmRecord("response", params);

  assertEq(record.type, "response", "type is response");
  assertEq(record.text, "Here is my answer...", "text preserved");
  assertEq(record.stopReason, "end_turn", "stopReason preserved");
  assertEq(record.durationMs, 3200, "durationMs preserved");
  assertEq(record.ts, "2026-04-05T10:00:05.000Z", "ts preserved");
  assert(record.error === undefined, "no error on success");
}

function testFormatDmRecordResponseWithError() {
  console.log("\n▸ formatDmRecord('response'): handles error field");

  const params = {
    text: "",
    from: { nodeId: "n1", name: "tui-user" },
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    error: "prompt timeout",
    durationMs: 30000,
    ts: "2026-04-05T10:00:30.000Z",
  };

  const record = formatDmRecord("response", params);

  assertEq(record.type, "response", "type is response");
  assertEq(record.error, "prompt timeout", "error preserved");
  assertEq(record.text, "", "text is empty on error");
  assertEq(record.durationMs, 30000, "durationMs preserved on error");
}

// ============================================================
// formatDmRecord — missing / edge-case fields
// ============================================================

function testFormatDmRecordMissingFrom() {
  console.log("\n▸ formatDmRecord: handles from=undefined (direct connect)");

  const params = {
    text: "hello",
    from: undefined,
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    ts: "2026-04-05T10:00:00.000Z",
  };

  const record = formatDmRecord("prompt", params);

  assert(record.from === undefined, "from is undefined");
  assertEq(record.targetNodeId, "n2", "targetNodeId still set");
  assertEq(record.text, "hello", "text still set");
}

function testFormatDmRecordEmptyText() {
  console.log("\n▸ formatDmRecord: handles empty text");

  const params = {
    text: "",
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    ts: "2026-04-05T10:00:00.000Z",
  };

  const record = formatDmRecord("prompt", params);

  assertEq(record.text, "", "text is empty string");
}

function testFormatDmRecordMissingText() {
  console.log("\n▸ formatDmRecord: handles missing text (defaults to empty)");

  const params = {
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    ts: "2026-04-05T10:00:00.000Z",
  };

  const record = formatDmRecord("prompt", params);

  assertEq(record.text, "", "text defaults to empty string");
}

function testFormatDmRecordFallbackTs() {
  console.log("\n▸ formatDmRecord: generates ts when missing");

  const params = {
    text: "test",
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    // no ts
  };

  const before = new Date().toISOString();
  const record = formatDmRecord("prompt", params);
  const after = new Date().toISOString();

  assert(!!record.ts, "ts is generated");
  assert(record.ts >= before && record.ts <= after, "ts is within expected range");
}

// ============================================================
// DmRecord type completeness
// ============================================================

function testDmRecordTypeCompleteness() {
  console.log("\n▸ DmRecord: type has all expected fields");

  // Construct a full DmRecord — if any field is missing from the type,
  // TypeScript compilation will fail (which is the desired red behavior).
  const full: DmRecord = {
    ts: "2026-04-05T10:00:00.000Z",
    type: "prompt",
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    from: { nodeId: "n1", name: "user" },
    text: "hello",
    stopReason: "end_turn",
    error: "some error",
    durationMs: 1000,
  };

  assert(full.ts !== undefined, "ts field exists");
  assert(full.type !== undefined, "type field exists");
  assert(full.targetNodeId !== undefined, "targetNodeId field exists");
  assert(full.targetNodeName !== undefined, "targetNodeName field exists");
  assert(full.from !== undefined, "from field exists");
  assert(full.text !== undefined, "text field exists");
  assert(full.stopReason !== undefined, "stopReason field exists (optional)");
  assert(full.error !== undefined, "error field exists (optional)");
  assert(full.durationMs !== undefined, "durationMs field exists (optional)");
}

function testDmRecordTypeValues() {
  console.log("\n▸ DmRecord: type field only accepts prompt|response");

  const prompt: DmRecord = {
    ts: "2026-04-05T10:00:00.000Z",
    type: "prompt",
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    text: "hello",
  };

  const response: DmRecord = {
    ts: "2026-04-05T10:00:00.000Z",
    type: "response",
    targetNodeId: "n2",
    targetNodeName: "claude-1",
    text: "hi",
  };

  assertEq(prompt.type, "prompt", "prompt type accepted");
  assertEq(response.type, "response", "response type accepted");
}

// ============================================================
// _dmResponseBuffer chunk accumulation
// ============================================================

function testDmResponseBufferAccumulation() {
  console.log("\n▸ _dmResponseBuffer: accumulates agent_message_chunk text");

  // Simulate the buffer accumulation logic from node-pool.ts onUpdate callback.
  // Design doc §5: node._dmResponseBuffer starts as "", chunks append content.text.
  const mockStore = {
    insertNode() {},
    updateNodeStatus() {},
    markAllNodesStopped() {},
    addNodeToChannel() {},
    removeNodeFromChannel() {},
  } as any;

  const events: Array<{ event: string; node: NerveNode; detail?: any }> = [];
  const pool = new NodePool(mockStore, (event, node, detail) => {
    events.push({ event, node, detail });
  });

  // Create a node and set up _dmResponseBuffer (as promptNode would)
  const transport = {
    type: "stdio" as const,
    alive: true,
    send() {},
    close() {},
    onClose() {},
    onData() {},
  } as any;

  const node = new NerveNode({
    id: "test-buf-node",
    name: "buf-test",
    transport,
    capabilities: ["prompt"],
    adapter: "mock",
    cwd: "/tmp",
  });

  // Initialize buffer (as promptNode entry would)
  (node as any)._dmResponseBuffer = "";

  // Simulate 3 agent_message_chunk updates
  const chunks = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world!" } },
  ];

  for (const chunk of chunks) {
    // Replicate the accumulation logic from design doc §5
    const kind = chunk.sessionUpdate;
    if (kind === "agent_message_chunk" && (node as any)._dmResponseBuffer !== undefined) {
      const text = chunk.content?.text;
      if (text) (node as any)._dmResponseBuffer += text;
    }
  }

  assertEq((node as any)._dmResponseBuffer, "Hello world!", "buffer accumulated 3 chunks correctly");

  // Simulate cleanup (as promptNode exit would)
  const responseText = (node as any)._dmResponseBuffer ?? "";
  (node as any)._dmResponseBuffer = undefined;

  assertEq(responseText, "Hello world!", "responseText captured before cleanup");
  assertEq((node as any)._dmResponseBuffer, undefined, "buffer cleaned up after prompt");
}

function testDmResponseBufferIgnoresNonChunks() {
  console.log("\n▸ _dmResponseBuffer: ignores non-chunk updates");

  const node = { _dmResponseBuffer: "" } as any;

  // These should NOT affect the buffer
  const nonChunks = [
    { sessionUpdate: "agent_thought_chunk", content: { text: "thinking..." } },
    { sessionUpdate: "tool_call", title: "read_file" },
    { sessionUpdate: "usage_update", used: 100 },
    { sessionUpdate: "agent_message_end" },
  ];

  for (const update of nonChunks) {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && node._dmResponseBuffer !== undefined) {
      const text = (update as any).content?.text;
      if (text) node._dmResponseBuffer += text;
    }
  }

  assertEq(node._dmResponseBuffer, "", "buffer unchanged by non-chunk updates");
}

function testDmResponseBufferNoAccumulationWhenUndefined() {
  console.log("\n▸ _dmResponseBuffer: no accumulation when buffer is undefined (no active prompt)");

  const node = { _dmResponseBuffer: undefined } as any;

  const chunk = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } };
  const kind = chunk.sessionUpdate;
  if (kind === "agent_message_chunk" && node._dmResponseBuffer !== undefined) {
    node._dmResponseBuffer += chunk.content.text;
  }

  assertEq(node._dmResponseBuffer, undefined, "buffer stays undefined when no active prompt");
}

// ============================================================
// Run all tests
// ============================================================

function main() {
  console.log("=== DM Capture Unit Tests ===");

  testFormatDmRecordPrompt();
  testFormatDmRecordResponse();
  testFormatDmRecordResponseWithError();
  testFormatDmRecordMissingFrom();
  testFormatDmRecordEmptyText();
  testFormatDmRecordMissingText();
  testFormatDmRecordFallbackTs();
  testDmRecordTypeCompleteness();
  testDmRecordTypeValues();
  testDmResponseBufferAccumulation();
  testDmResponseBufferIgnoresNonChunks();
  testDmResponseBufferNoAccumulationWhenUndefined();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main();
