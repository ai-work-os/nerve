#!/usr/bin/env npx tsx
/**
 * Protocol unit tests — LineBuffer + type guards + encode functions
 * Run: npx tsx test/unit/protocol.test.ts
 */

import {
  LineBuffer,
  isRequest,
  isResponse,
  isNotification,
  encodeRequest,
  encodeResponse,
  encodeError,
  encodeNotification,
} from "../../../src/transport/protocol.js";
import type { JsonRpcMessage } from "../../../src/transport/protocol.js";

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
// LineBuffer
// ============================================================

function testLineBufferCompleteLine() {
  console.log("\n\u25b8 LineBuffer: complete line");
  const lb = new LineBuffer();
  assertEq(lb.feed("hello\n"), ["hello"], "complete line returned");
}

function testLineBufferFragmented() {
  console.log("\n\u25b8 LineBuffer: fragmented input");
  const lb = new LineBuffer();
  assertEq(lb.feed("hel"), [], "first fragment returns nothing");
  assertEq(lb.feed("lo\n"), ["hello"], "second fragment completes line");
}

function testLineBufferMultipleLines() {
  console.log("\n\u25b8 LineBuffer: multiple lines at once");
  const lb = new LineBuffer();
  assertEq(lb.feed("a\nb\n"), ["a", "b"], "two lines returned");
}

function testLineBufferEmptyLinesSkipped() {
  console.log("\n\u25b8 LineBuffer: empty lines skipped");
  const lb = new LineBuffer();
  assertEq(lb.feed("\n\n"), [], "empty lines produce nothing");
}

function testLineBufferNoNewline() {
  console.log("\n\u25b8 LineBuffer: no newline stays in buffer");
  const lb = new LineBuffer();
  assertEq(lb.feed("partial"), [], "no output without newline");
}

function testLineBufferTrimWhitespace() {
  console.log("\n\u25b8 LineBuffer: whitespace trimmed");
  const lb = new LineBuffer();
  assertEq(lb.feed("  hello  \n"), ["hello"], "leading/trailing spaces trimmed");
}

// ============================================================
// Type guards
// ============================================================

function testIsRequest() {
  console.log("\n\u25b8 isRequest");
  const req: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "test" };
  assert(isRequest(req), "request with method + id \u2192 true");
  assert(!isNotification(req), "request is not a notification");
}

function testIsResponse() {
  console.log("\n\u25b8 isResponse");
  const res: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: "ok" };
  assert(isResponse(res), "response with id + result \u2192 true");
  assert(!isRequest(res), "response is not a request");
}

function testIsResponseError() {
  console.log("\n\u25b8 isResponse (error)");
  const res: JsonRpcMessage = { jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } };
  assert(isResponse(res), "error response with id + error \u2192 true");
}

function testIsNotification() {
  console.log("\n\u25b8 isNotification");
  const notif: JsonRpcMessage = { jsonrpc: "2.0", method: "notify" };
  assert(isNotification(notif), "notification with method, no id \u2192 true");
  assert(!isRequest(notif), "notification is not a request");
}

// ============================================================
// Encode functions
// ============================================================

function testEncodeRequest() {
  console.log("\n\u25b8 encodeRequest");
  const raw = encodeRequest(1, "test", { a: 1 });
  const parsed = JSON.parse(raw);
  assertEq(parsed.jsonrpc, "2.0", "jsonrpc field");
  assertEq(parsed.id, 1, "id field");
  assertEq(parsed.method, "test", "method field");
  assertEq(parsed.params, { a: 1 }, "params field");
}

function testEncodeResponse() {
  console.log("\n\u25b8 encodeResponse");
  const raw = encodeResponse(2, { ok: true });
  const parsed = JSON.parse(raw);
  assertEq(parsed.jsonrpc, "2.0", "jsonrpc field");
  assertEq(parsed.id, 2, "id field");
  assertEq(parsed.result, { ok: true }, "result field");
}

function testEncodeError() {
  console.log("\n\u25b8 encodeError");
  const raw = encodeError(3, -32600, "Invalid");
  const parsed = JSON.parse(raw);
  assertEq(parsed.jsonrpc, "2.0", "jsonrpc field");
  assertEq(parsed.id, 3, "id field");
  assertEq(parsed.error.code, -32600, "error.code");
  assertEq(parsed.error.message, "Invalid", "error.message");
}

function testEncodeNotification() {
  console.log("\n\u25b8 encodeNotification");
  const raw = encodeNotification("event", { x: 1 });
  const parsed = JSON.parse(raw);
  assertEq(parsed.jsonrpc, "2.0", "jsonrpc field");
  assertEq(parsed.method, "event", "method field");
  assertEq(parsed.params, { x: 1 }, "params field");
  assert(!("id" in parsed), "no id field");
}

// ============================================================
// MAIN
// ============================================================

function main() {
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log("  Protocol Tests (LineBuffer + guards + encode)");
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

  // LineBuffer
  testLineBufferCompleteLine();
  testLineBufferFragmented();
  testLineBufferMultipleLines();
  testLineBufferEmptyLinesSkipped();
  testLineBufferNoNewline();
  testLineBufferTrimWhitespace();

  // Type guards
  testIsRequest();
  testIsResponse();
  testIsResponseError();
  testIsNotification();

  // Encode
  testEncodeRequest();
  testEncodeResponse();
  testEncodeError();
  testEncodeNotification();

  // Summary
  console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    \u2717 ${f}`);
    }
  }
  console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
