#!/usr/bin/env npx tsx
/**
 * User Recorder Plugin Tests (TDD)
 *
 * Tests for the user-recorder plugin that records messages from client nodes
 * (TUI, Android, Web) via nerve message stream.
 *
 * Run: npx tsx test/user-recorder.test.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_DATA = resolve(ROOT, ".test-data-user-recorder");

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

// ============================================================
// UNIT TESTS — pure logic, no server needed
// ============================================================

import {
  shouldRecord,
  formatRecord,
  sessionKey,
  readSessionMessages,
  getSessionsForDate,
  formatStatusReport,
  formatDateReport,
  type UserMessage,
} from "../src/plugins/user-recorder/logic.js";

// --- shouldRecord ---

function testShouldRecordWebsocket() {
  console.log("\n▸ shouldRecord: accepts websocket (client) messages");

  assert(shouldRecord({ nodeType: "websocket" }), "websocket nodeType → true");
  assert(!shouldRecord({ nodeType: "stdio" }), "stdio nodeType → false");
  assert(!shouldRecord({ nodeType: "program" }), "program nodeType → false");
  assert(!shouldRecord(undefined), "undefined metadata → false");
  assert(!shouldRecord({}), "empty metadata → false");
  assert(!shouldRecord({ nodeType: undefined }), "undefined nodeType → false");
}

// --- formatRecord ---

function testFormatRecord() {
  console.log("\n▸ formatRecord: structures channel message into UserMessage");

  const params = {
    channelId: "ch-abc",
    message: {
      from: "tui",
      content: "hello world",
      metadata: { nodeType: "websocket" },
    },
  };

  const record = formatRecord(params);

  assert(!!record.ts, "has timestamp");
  assertEq(record.channelId, "ch-abc", "has channelId");
  assertEq(record.from, "tui", "has from");
  assertEq(record.content, "hello world", "has content");
}

function testFormatRecordFlatParams() {
  console.log("\n▸ formatRecord: handles flat params (no message wrapper)");

  const params = {
    channelId: "ch-xyz",
    from: "android-ui",
    content: "test message",
    metadata: { nodeType: "websocket" },
  };

  const record = formatRecord(params);
  assertEq(record.from, "android-ui", "from from flat params");
  assertEq(record.content, "test message", "content from flat params");
}

// --- sessionKey ---

function testSessionKey() {
  console.log("\n▸ sessionKey: generates file-safe session key from channelId");

  assertEq(sessionKey("ch-abc123"), "ch-abc123", "simple id unchanged");
  assertEq(sessionKey("aNU8furJ2cR-"), "aNU8furJ2cR-", "real channel id preserved");
}

// --- readSessionMessages ---

function testReadSessionMessages() {
  console.log("\n▸ readSessionMessages: reads JSONL session file");

  // Setup test data
  const sessionsDir = resolve(TEST_DATA, "sessions-read");
  mkdirSync(sessionsDir, { recursive: true });

  const msg1: UserMessage = { ts: "2026-04-05T10:00:00.000Z", channelId: "ch-1", from: "tui", content: "hello" };
  const msg2: UserMessage = { ts: "2026-04-05T10:01:00.000Z", channelId: "ch-1", from: "tui", content: "world" };
  writeFileSync(resolve(sessionsDir, "ch-1.jsonl"), JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n");

  const messages = readSessionMessages(sessionsDir, "ch-1");
  assertEq(messages.length, 2, "reads 2 messages");
  assertEq(messages[0].content, "hello", "first message content");
  assertEq(messages[1].content, "world", "second message content");
}

function testReadSessionMessagesEmpty() {
  console.log("\n▸ readSessionMessages: returns empty for non-existent session");

  const sessionsDir = resolve(TEST_DATA, "sessions-empty");
  mkdirSync(sessionsDir, { recursive: true });

  const messages = readSessionMessages(sessionsDir, "non-existent");
  assertEq(messages.length, 0, "empty for missing file");
}

function testReadSessionMessagesCorrupted() {
  console.log("\n▸ readSessionMessages: skips corrupted lines");

  const sessionsDir = resolve(TEST_DATA, "sessions-corrupt");
  mkdirSync(sessionsDir, { recursive: true });

  const valid: UserMessage = { ts: "2026-04-05T10:00:00.000Z", channelId: "ch-1", from: "tui", content: "ok" };
  writeFileSync(
    resolve(sessionsDir, "ch-1.jsonl"),
    JSON.stringify(valid) + "\n" + "not-json\n" + "\n"
  );

  const messages = readSessionMessages(sessionsDir, "ch-1");
  assertEq(messages.length, 1, "skips bad lines, keeps valid");
}

// --- getSessionsForDate ---

function testGetSessionsForDate() {
  console.log("\n▸ getSessionsForDate: filters sessions by date");

  const sessionsDir = resolve(TEST_DATA, "sessions-date");
  mkdirSync(sessionsDir, { recursive: true });

  // ch-1: messages on 2026-04-05
  const m1: UserMessage = { ts: "2026-04-05T10:00:00.000Z", channelId: "ch-1", from: "tui", content: "a" };
  const m2: UserMessage = { ts: "2026-04-05T11:00:00.000Z", channelId: "ch-1", from: "tui", content: "b" };
  writeFileSync(resolve(sessionsDir, "ch-1.jsonl"), JSON.stringify(m1) + "\n" + JSON.stringify(m2) + "\n");

  // ch-2: messages on 2026-04-04 (different date)
  const m3: UserMessage = { ts: "2026-04-04T09:00:00.000Z", channelId: "ch-2", from: "android", content: "c" };
  writeFileSync(resolve(sessionsDir, "ch-2.jsonl"), JSON.stringify(m3) + "\n");

  // ch-3: messages spanning both dates
  const m4: UserMessage = { ts: "2026-04-04T23:00:00.000Z", channelId: "ch-3", from: "tui", content: "d" };
  const m5: UserMessage = { ts: "2026-04-05T01:00:00.000Z", channelId: "ch-3", from: "tui", content: "e" };
  writeFileSync(resolve(sessionsDir, "ch-3.jsonl"), JSON.stringify(m4) + "\n" + JSON.stringify(m5) + "\n");

  const result = getSessionsForDate(sessionsDir, "2026-04-05");
  // ch-1 has 2 msgs on 04-05, ch-3 has 1 msg on 04-05, ch-2 has 0
  assertEq(result.length, 2, "2 sessions have messages on 2026-04-05");

  const ch1 = result.find(s => s.channelId === "ch-1");
  assertEq(ch1?.messages.length, 2, "ch-1 has 2 messages on that date");

  const ch3 = result.find(s => s.channelId === "ch-3");
  assertEq(ch3?.messages.length, 1, "ch-3 has 1 message on that date");
}

// --- formatStatusReport ---

function testFormatStatusReport() {
  console.log("\n▸ formatStatusReport: formats status output");

  const sessionsDir = resolve(TEST_DATA, "sessions-status");
  mkdirSync(sessionsDir, { recursive: true });

  const m1: UserMessage = { ts: "2026-04-05T10:00:00.000Z", channelId: "ch-1", from: "tui", content: "a" };
  const m2: UserMessage = { ts: "2026-04-05T11:00:00.000Z", channelId: "ch-1", from: "tui", content: "b" };
  writeFileSync(resolve(sessionsDir, "ch-1.jsonl"), JSON.stringify(m1) + "\n" + JSON.stringify(m2) + "\n");

  const m3: UserMessage = { ts: "2026-04-05T12:00:00.000Z", channelId: "ch-2", from: "android", content: "c" };
  writeFileSync(resolve(sessionsDir, "ch-2.jsonl"), JSON.stringify(m3) + "\n");

  const status = formatStatusReport(sessionsDir);
  assert(status.includes("3"), "total messages count includes 3");
  assert(status.includes("2"), "session count includes 2");
}

// --- formatDateReport ---

function testFormatDateReport() {
  console.log("\n▸ formatDateReport: formats date report");

  const sessionsDir = resolve(TEST_DATA, "sessions-report");
  mkdirSync(sessionsDir, { recursive: true });

  const m1: UserMessage = { ts: "2026-04-05T10:00:00.000Z", channelId: "ch-1", from: "tui", content: "hello" };
  const m2: UserMessage = { ts: "2026-04-05T11:00:00.000Z", channelId: "ch-1", from: "tui", content: "world" };
  writeFileSync(resolve(sessionsDir, "ch-1.jsonl"), JSON.stringify(m1) + "\n" + JSON.stringify(m2) + "\n");

  const report = formatDateReport(sessionsDir, "2026-04-05");
  assert(report.includes("2026-04-05"), "report includes date");
  assert(report.includes("ch-1"), "report includes channel id");
  assert(report.includes("2"), "report includes message count");
}

function testFormatDateReportEmpty() {
  console.log("\n▸ formatDateReport: handles no data for date");

  const sessionsDir = resolve(TEST_DATA, "sessions-report-empty");
  mkdirSync(sessionsDir, { recursive: true });

  const report = formatDateReport(sessionsDir, "2026-04-05");
  assert(report.includes("2026-04-05"), "report includes date");
  assert(report.includes("0") || report.toLowerCase().includes("no"), "indicates no sessions");
}

// --- Recording pipeline integration (no server, tests logic end-to-end) ---

function testRecordingPipeline() {
  console.log("\n▸ Recording pipeline: filter → format → write → read round-trip");

  const sessionsDir = resolve(TEST_DATA, "sessions-pipeline");
  mkdirSync(sessionsDir, { recursive: true });

  // Simulate channel.message notifications
  const wsMessage = {
    channelId: "ch-pipeline",
    message: { from: "tui", content: "user typed this", metadata: { nodeType: "websocket" } },
  };
  const stdioMessage = {
    channelId: "ch-pipeline",
    message: { from: "claude-1", content: "ai reply", metadata: { nodeType: "stdio" } },
  };
  const programMessage = {
    channelId: "ch-pipeline",
    message: { from: "observer", content: "plugin msg", metadata: { nodeType: "program" } },
  };

  // Step 1: filter — only websocket passes
  assert(shouldRecord(wsMessage.message.metadata), "pipeline: websocket passes filter");
  assert(!shouldRecord(stdioMessage.message.metadata), "pipeline: stdio blocked");
  assert(!shouldRecord(programMessage.message.metadata), "pipeline: program blocked");

  // Step 2: format — extract UserMessage
  const record = formatRecord(wsMessage);
  assertEq(record.channelId, "ch-pipeline", "pipeline: channelId preserved");
  assertEq(record.from, "tui", "pipeline: from preserved");
  assertEq(record.content, "user typed this", "pipeline: content preserved");

  // Step 3: write to JSONL (simulating what recordMessage does)
  const key = sessionKey(record.channelId);
  const filePath = resolve(sessionsDir, `${key}.jsonl`);
  writeFileSync(filePath, JSON.stringify(record) + "\n");

  // Send a second user message
  const wsMessage2 = {
    channelId: "ch-pipeline",
    message: { from: "android-ui", content: "second msg", metadata: { nodeType: "websocket" } },
  };
  const record2 = formatRecord(wsMessage2);
  appendFileSync(filePath, JSON.stringify(record2) + "\n");

  // Step 4: read back and verify
  const messages = readSessionMessages(sessionsDir, "ch-pipeline");
  assertEq(messages.length, 2, "pipeline: 2 messages written and read back");
  assertEq(messages[0].from, "tui", "pipeline: first message from tui");
  assertEq(messages[1].from, "android-ui", "pipeline: second message from android-ui");

  // Step 5: verify status reflects the data
  const status = formatStatusReport(sessionsDir);
  assert(status.includes("2"), "pipeline: status shows 2 messages");
  assert(status.includes("1"), "pipeline: status shows 1 session");
}

// ============================================================
// INTEGRATION TEST — plugin node commands
// ============================================================

import { UserRecorder } from "../src/plugins/user-recorder/index.js";

function testPluginCommands() {
  console.log("\n▸ UserRecorder: declares expected commands");

  const origEnv = process.env.HOME;
  process.env.HOME = TEST_DATA;
  try {
    const recorder = new UserRecorder(19999);
    const commands = recorder.getCommands();

    assert("status" in commands, "has status command");
    assert("report" in commands, "has report command");
    assertEq(Object.keys(commands).length, 2, "exactly 2 commands");

    const events = recorder.getEvents();
    assert(Array.isArray(events), "getEvents returns array");
    assertEq(events.length, 0, "no events declared (no emit RPC)");
  } finally {
    process.env.HOME = origEnv;
  }
}

// ============================================================
// Run all tests
// ============================================================

async function main() {
  console.log("=== User Recorder Tests ===");

  // Clean test data
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  mkdirSync(TEST_DATA, { recursive: true });

  try {
    // Unit tests
    testShouldRecordWebsocket();
    testFormatRecord();
    testFormatRecordFlatParams();
    testSessionKey();
    testReadSessionMessages();
    testReadSessionMessagesEmpty();
    testReadSessionMessagesCorrupted();
    testGetSessionsForDate();
    testFormatStatusReport();
    testFormatDateReport();
    testFormatDateReportEmpty();
    testRecordingPipeline();

    // Integration
    testPluginCommands();
  } finally {
    // Cleanup
    if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
