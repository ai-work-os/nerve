#!/usr/bin/env npx tsx
/**
 * RequestHandler unit tests
 * Tests pure request handling logic without WebSocket dependency.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../../../src/channel/channel-manager.js";
import { handleRpcRequest, type RequestResult } from "../../../src/channel/request-handler.js";

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

// --- Setup ---

const dataDir = mkdtempSync(join(tmpdir(), "nerve-rh-test-"));
const cm = new ChannelManager({ dataDir, port: 0 });
const ctx = {};

function call(method: string, params: Record<string, unknown> = {}): RequestResult | null {
  return handleRpcRequest(cm, method, params, ctx) as RequestResult | null;
}

// --- Tests ---

function main() {
  console.log("═══════════════════════════════════════");
  console.log("  RequestHandler Tests");
  console.log("═══════════════════════════════════════");

  // channel.create
  console.log("\n▸ channel.create");
  const createResult = call("channel.create", { cwd: "/tmp/test-rh" });
  assert(createResult !== null, "returns non-null");
  assert(createResult!.ok === true, "ok is true");
  const createData = (createResult as any).data;
  assert(!!createData.channelId, "channelId exists");
  assertEq(createData.cwd, "/tmp/test-rh", "cwd matches");
  const channelId = createData.channelId;

  // channel.list
  console.log("\n▸ channel.list");
  const listResult = call("channel.list", {});
  assert(listResult !== null && listResult.ok === true, "list ok");
  const listData = (listResult as any).data;
  assert(listData.channels.length >= 1, "at least 1 channel");
  assert(listData.channels.some((c: any) => c.id === channelId), "contains created channel");

  // channel.list with cwd filter
  console.log("\n▸ channel.list with cwd filter");
  const filteredResult = call("channel.list", { cwd: "/tmp/test-rh" });
  assert(filteredResult !== null && filteredResult.ok === true, "filtered list ok");
  const filteredData = (filteredResult as any).data;
  assert(filteredData.channels.length >= 1, "filter returns matching channels");

  const noMatchResult = call("channel.list", { cwd: "/nonexistent/path" });
  assert(noMatchResult !== null && noMatchResult.ok === true, "no-match list ok");
  assertEq((noMatchResult as any).data.channels.length, 0, "no channels for unmatched cwd");

  // channel.history
  console.log("\n▸ channel.history");
  const histResult = call("channel.history", { channelId });
  assert(histResult !== null && histResult.ok === true, "history ok");
  assert(Array.isArray((histResult as any).data.messages), "messages is array");

  // channel.delete without channelId
  console.log("\n▸ channel.delete without channelId");
  const delNoId = call("channel.delete", {});
  assert(delNoId !== null && delNoId.ok === false, "error returned");
  assertEq((delNoId as any).code, -32602, "error code -32602");

  // channel.delete with channelId
  console.log("\n▸ channel.delete with channelId");
  const delResult = call("channel.delete", { channelId });
  assert(delResult !== null && delResult.ok === true, "delete ok");

  // channel.close
  console.log("\n▸ channel.close");
  const ch2 = call("channel.create", { cwd: "/tmp/test-rh-2" });
  const ch2Id = (ch2 as any).data.channelId;
  const closeResult = call("channel.close", { channelId: ch2Id });
  assert(closeResult !== null && closeResult.ok === true, "close ok");

  // node.list empty
  console.log("\n▸ node.list empty");
  const nodeResult = call("node.list", {});
  assert(nodeResult !== null && nodeResult.ok === true, "node.list ok");
  assertEq((nodeResult as any).data.nodes.length, 0, "empty nodes");

  // node.updates without nodeName
  console.log("\n▸ node.updates without nodeName");
  const updNoName = call("node.updates", {});
  assert(updNoName !== null && updNoName.ok === false, "error returned");
  assertEq((updNoName as any).code, -32602, "error code -32602");

  // node.updates with nodeName
  console.log("\n▸ node.updates with nodeName");
  const updResult = call("node.updates", { nodeName: "nonexistent" });
  assert(updResult !== null && updResult.ok === true, "ok for unknown node");
  assert(Array.isArray((updResult as any).data.updates), "updates is array");

  // blob.get without blobId
  console.log("\n▸ blob.get without blobId");
  const blobNoId = call("blob.get", {});
  assert(blobNoId !== null && blobNoId.ok === false, "error returned");
  assertEq((blobNoId as any).code, -32602, "error code -32602");

  // blob.get with unknown blobId
  console.log("\n▸ blob.get with unknown blobId");
  const blobUnknown = call("blob.get", { blobId: "unknown-id" });
  assert(blobUnknown !== null && blobUnknown.ok === false, "blob not found");

  // unknown method → null
  console.log("\n▸ unknown method → null");
  const unknownResult = call("some.unknown.method", {});
  assertEq(unknownResult, null, "returns null for unknown method");

  // Cleanup
  cm.shutdown();
  rmSync(dataDir, { recursive: true, force: true });

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
