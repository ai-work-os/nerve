#!/usr/bin/env npx tsx
/**
 * Dialog Recorder — scanner module tests
 *
 * TDD Phase: RED — all tests should fail (scanner not implemented).
 * Run: cd nerve && npx tsx test/dialog-recorder.test.ts
 */

import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  scanProjects,
  extractUserMessages,
  cleanContent,
  type DialogEntry,
} from "../src/plugins/dialog-recorder/scanner.js";
import {
  aggregateDailyStats,
  formatDailyReport,
  type DailyStats,
} from "../src/plugins/dialog-recorder/reporter.js";
import { DialogRecorder } from "../src/plugins/dialog-recorder/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Test infrastructure (same pattern as self-test.ts) ---

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

// --- Helpers ---

function tmpDir(): string {
  const dir = resolve(tmpdir(), `dialog-recorder-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a mock JSONL file with Claude Code conversation format */
function makeJsonlFile(dir: string, projectSlug: string, sessionId: string, lines: object[]): string {
  const projectDir = resolve(dir, projectSlug);
  mkdirSync(projectDir, { recursive: true });
  const filePath = resolve(projectDir, `${sessionId}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(filePath, content);
  return filePath;
}

function userMessage(content: string, extra: Partial<Record<string, unknown>> = {}): object {
  return {
    type: "user",
    message: { content },
    cwd: "/Users/test/project",
    timestamp: "2026-04-05T10:00:00Z",
    sessionId: "sess-001",
    gitBranch: "dev",
    ...extra,
  };
}

function assistantMessage(content: string): object {
  return {
    type: "assistant",
    message: { content },
    timestamp: "2026-04-05T10:00:01Z",
  };
}

function queueOperation(): object {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-04-05T10:00:02Z",
  };
}

// --- Tests ---

async function testExtractUserMessages(): Promise<void> {
  console.log("\n## extractUserMessages");

  const dir = tmpDir();
  try {
    const filePath = makeJsonlFile(dir, "project-a", "sess-001", [
      userMessage("hello world"),
      assistantMessage("hi there"),
      userMessage("second message"),
      queueOperation(),
      userMessage("third message"),
    ]);

    // Test 1: extracts only user messages
    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 3, "extracts 3 user messages, skips assistant and queue-operation");
    assertEq(result.entries[0].content, "hello world", "first message content");
    assertEq(result.entries[1].content, "second message", "second message content");
    assertEq(result.entries[2].content, "third message", "third message content");
    assertEq(result.linesRead, 5, "linesRead = total lines");

    // Test 2: startLine > 0 skips already-read lines
    const result2 = await extractUserMessages(filePath, 3);
    assertEq(result2.entries.length, 1, "startLine=3 skips first 3 lines, gets 1 user msg");
    assertEq(result2.entries[0].content, "third message", "gets third message after skip");
    assertEq(result2.linesRead, 2, "linesRead = only new lines (2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testCleanContent(): Promise<void> {
  console.log("\n## cleanContent");

  // Test 3: remove system-reminder tags
  const withReminder = "hello <system-reminder>secret stuff here</system-reminder> world";
  const cleaned1 = cleanContent(withReminder);
  assertEq(cleaned1, "hello  world", "removes <system-reminder> tags and content");

  // Test 4: remove local-command-caveat tags
  const withCaveat = "start <local-command-caveat>caveat content</local-command-caveat> end";
  const cleaned2 = cleanContent(withCaveat);
  assertEq(cleaned2, "start  end", "removes <local-command-caveat> tags and content");

  // Test 5: plain text unchanged
  const plain = "just a normal message";
  const cleaned3 = cleanContent(plain);
  assertEq(cleaned3, "just a normal message", "plain text passes through unchanged");

  // Bonus: multiple tags
  const multi = "<system-reminder>a</system-reminder>text<local-command-caveat>b</local-command-caveat>end";
  const cleaned4 = cleanContent(multi);
  assertEq(cleaned4, "textend", "removes multiple different tags");
}

async function testScanProjects(): Promise<void> {
  console.log("\n## scanProjects");

  const dir = tmpDir();
  try {
    // Create two project dirs with JSONL files
    makeJsonlFile(dir, "-Users-test-project-a", "sess-001", [
      userMessage("msg from project a", { sessionId: "sess-001", cwd: "/Users/test/project-a" }),
    ]);
    makeJsonlFile(dir, "-Users-test-project-b", "sess-002", [
      userMessage("msg from project b", { sessionId: "sess-002", cwd: "/Users/test/project-b" }),
      userMessage("second msg project b", { sessionId: "sess-002", cwd: "/Users/test/project-b" }),
    ]);

    // Test 6: full scan discovers all files and extracts entries
    const result = await scanProjects(dir, {});
    assertEq(result.entries.length, 3, "full scan finds 3 user messages across 2 projects");
    assert(
      Object.keys(result.newOffsets).length === 2,
      "newOffsets has 2 file entries",
    );

    // Test 7: incremental scan — second call with previous offsets gets no new entries
    const result2 = await scanProjects(dir, result.newOffsets);
    assertEq(result2.entries.length, 0, "incremental scan with same offsets returns 0 new entries");

    // Add new messages to project b
    const projectBDir = resolve(dir, "-Users-test-project-b");
    const existingPath = resolve(projectBDir, "sess-002.jsonl");
    const newLine = JSON.stringify(userMessage("new msg", { sessionId: "sess-002", cwd: "/Users/test/project-b" })) + "\n";
    appendFileSync(existingPath, newLine);

    // Incremental scan should pick up only the new message
    const result3 = await scanProjects(dir, result.newOffsets);
    assertEq(result3.entries.length, 1, "incremental scan picks up 1 new message");
    assertEq(result3.entries[0].content, "new msg", "new message content correct");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Edge case tests ---

async function testExtractEmptyFile(): Promise<void> {
  console.log("\n## extractUserMessages — empty file");

  const dir = tmpDir();
  try {
    const projectDir = resolve(dir, "project-empty");
    mkdirSync(projectDir, { recursive: true });
    const filePath = resolve(projectDir, "sess-empty.jsonl");
    writeFileSync(filePath, "");

    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 0, "empty JSONL file → 0 entries");
    assertEq(result.linesRead, 0, "empty file → 0 linesRead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testExtractCorruptedLines(): Promise<void> {
  console.log("\n## extractUserMessages — corrupted JSON lines");

  const dir = tmpDir();
  try {
    const projectDir = resolve(dir, "project-corrupt");
    mkdirSync(projectDir, { recursive: true });
    const filePath = resolve(projectDir, "sess-corrupt.jsonl");
    const lines = [
      JSON.stringify(userMessage("before corrupt")),
      "THIS IS NOT JSON {{{",
      JSON.stringify(userMessage("after corrupt")),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 2, "skips corrupted line, extracts 2 valid user messages");
    assertEq(result.entries[0].content, "before corrupt", "first valid message");
    assertEq(result.entries[1].content, "after corrupt", "second valid message after corrupt line");
    assertEq(result.linesRead, 3, "linesRead counts all lines including corrupt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testExtractArrayContent(): Promise<void> {
  console.log("\n## extractUserMessages — array content format");

  const dir = tmpDir();
  try {
    const filePath = makeJsonlFile(dir, "project-array", "sess-arr", [
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "hello " },
            { type: "image", source: "img.png" },
            { type: "text", text: "world" },
          ],
        },
        cwd: "/Users/test/project",
        timestamp: "2026-04-05T10:00:00Z",
        sessionId: "sess-arr",
      },
    ]);

    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 1, "array content → 1 entry");
    assertEq(result.entries[0].content, "hello world", "concatenates text items, skips non-text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testExtractNullContent(): Promise<void> {
  console.log("\n## extractUserMessages — undefined/null content");

  const dir = tmpDir();
  try {
    const filePath = makeJsonlFile(dir, "project-null", "sess-null", [
      { type: "user", message: {}, cwd: "/test", timestamp: "2026-04-05T10:00:00Z", sessionId: "s1" },
      { type: "user", message: { content: null }, cwd: "/test", timestamp: "2026-04-05T10:00:01Z", sessionId: "s1" },
    ]);

    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 2, "null/undefined content → still produces entries");
    assertEq(result.entries[0].content, "", "undefined content → empty string");
    assertEq(result.entries[1].content, "", "null content → empty string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testScanNonexistentDir(): Promise<void> {
  console.log("\n## scanProjects — nonexistent directory");

  const result = await scanProjects("/tmp/this-dir-does-not-exist-" + randomBytes(8).toString("hex"), {});
  assertEq(result.entries.length, 0, "nonexistent dir → 0 entries");
  assertEq(Object.keys(result.newOffsets).length, 0, "nonexistent dir → empty offsets");
}

async function testExtractEmptyContent(): Promise<void> {
  console.log("\n## extractUserMessages — type=user but content=''");

  const dir = tmpDir();
  try {
    const filePath = makeJsonlFile(dir, "project-empty-content", "sess-ec", [
      userMessage(""),
      userMessage("real message"),
    ]);

    const result = await extractUserMessages(filePath, 0);
    assertEq(result.entries.length, 2, "empty content user message still extracted");
    assertEq(result.entries[0].content, "", "empty content preserved as empty string");
    assertEq(result.entries[0].contentLength, 0, "empty content → contentLength=0");
    assertEq(result.entries[1].content, "real message", "real message unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Reporter tests ---

/** Helper: write a dialogs JSONL file for a given date */
function makeDialogsFile(dialogsDir: string, date: string, entries: DialogEntry[]): string {
  mkdirSync(dialogsDir, { recursive: true });
  const filePath = resolve(dialogsDir, `${date}.jsonl`);
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content);
  return filePath;
}

function dialogEntry(overrides: Partial<DialogEntry> = {}): DialogEntry {
  return {
    ts: "2026-04-05T10:30:00Z",
    sessionId: "sess-001",
    project: "-Users-test-project-a",
    cwd: "/Users/test/project-a",
    content: "test message",
    contentLength: 12,
    ...overrides,
  };
}

async function testAggregateDailyStats(): Promise<void> {
  console.log("\n## aggregateDailyStats — basic stats");

  const dir = tmpDir();
  const dialogsDir = resolve(dir, "dialogs");
  try {
    const entries: DialogEntry[] = [
      dialogEntry({ ts: "2026-04-05T10:00:00Z", sessionId: "sess-001", project: "-Users-test-project-a", content: "msg1", contentLength: 4 }),
      dialogEntry({ ts: "2026-04-05T11:00:00Z", sessionId: "sess-001", project: "-Users-test-project-a", content: "msg2", contentLength: 4 }),
      dialogEntry({ ts: "2026-04-05T14:00:00Z", sessionId: "sess-002", project: "-Users-test-project-b", content: "msg3", contentLength: 4 }),
      dialogEntry({ ts: "2026-04-05T14:30:00Z", sessionId: "sess-002", project: "-Users-test-project-b", content: "msg4", contentLength: 4 }),
      dialogEntry({ ts: "2026-04-05T16:00:00Z", sessionId: "sess-003", project: "-Users-test-project-a", content: "msg5", contentLength: 4 }),
    ];
    makeDialogsFile(dialogsDir, "2026-04-05", entries);

    const stats = await aggregateDailyStats(dialogsDir, "2026-04-05");
    assertEq(stats.date, "2026-04-05", "date correct");
    assertEq(stats.totalMessages, 5, "totalMessages = 5");
    assertEq(stats.totalSessions, 3, "totalSessions = 3 (sess-001, sess-002, sess-003)");
    assertEq(stats.projects["-Users-test-project-a"]?.messages, 3, "project-a has 3 messages");
    assertEq(stats.projects["-Users-test-project-b"]?.messages, 2, "project-b has 2 messages");
    assertEq(stats.entries.length, 5, "entries preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testAggregateDailyStatsHourDistribution(): Promise<void> {
  console.log("\n## aggregateDailyStats — hour distribution");

  const dir = tmpDir();
  const dialogsDir = resolve(dir, "dialogs");
  try {
    const entries: DialogEntry[] = [
      dialogEntry({ ts: "2026-04-05T08:10:00Z" }),
      dialogEntry({ ts: "2026-04-05T08:45:00Z" }),
      dialogEntry({ ts: "2026-04-05T14:00:00Z" }),
      dialogEntry({ ts: "2026-04-05T23:59:59Z" }),
    ];
    makeDialogsFile(dialogsDir, "2026-04-05", entries);

    const stats = await aggregateDailyStats(dialogsDir, "2026-04-05");
    assertEq(stats.hourDistribution.length, 24, "hourDistribution has 24 slots");
    assertEq(stats.hourDistribution[8], 2, "hour 8 has 2 messages");
    assertEq(stats.hourDistribution[14], 1, "hour 14 has 1 message");
    assertEq(stats.hourDistribution[23], 1, "hour 23 has 1 message");
    assertEq(stats.hourDistribution[0], 0, "hour 0 has 0 messages");
    assertEq(stats.hourDistribution[12], 0, "hour 12 has 0 messages");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testAggregateDailyStatsNoData(): Promise<void> {
  console.log("\n## aggregateDailyStats — no data for date");

  const dir = tmpDir();
  const dialogsDir = resolve(dir, "dialogs");
  mkdirSync(dialogsDir, { recursive: true });
  try {
    // Dialogs dir exists but no file for this date
    const stats = await aggregateDailyStats(dialogsDir, "2026-01-01");
    assertEq(stats.totalMessages, 0, "no data → totalMessages = 0");
    assertEq(stats.totalSessions, 0, "no data → totalSessions = 0");
    assertEq(Object.keys(stats.projects).length, 0, "no data → empty projects");
    assertEq(stats.entries.length, 0, "no data → empty entries");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testAggregateDailyStatsFileNotExist(): Promise<void> {
  console.log("\n## aggregateDailyStats — dialogsDir does not exist");

  const nonexistent = "/tmp/dialog-recorder-nonexist-" + randomBytes(8).toString("hex");
  const stats = await aggregateDailyStats(nonexistent, "2026-04-05");
  assertEq(stats.totalMessages, 0, "nonexistent dir → totalMessages = 0");
  assertEq(stats.totalSessions, 0, "nonexistent dir → totalSessions = 0");
  assertEq(stats.entries.length, 0, "nonexistent dir → empty entries");
}

async function testFormatDailyReport(): Promise<void> {
  console.log("\n## formatDailyReport — content check");

  const stats: DailyStats = {
    date: "2026-04-05",
    totalMessages: 5,
    totalSessions: 2,
    projects: {
      "-Users-test-project-a": { messages: 3, sessions: new Set(["sess-001", "sess-003"]) },
      "-Users-test-project-b": { messages: 2, sessions: new Set(["sess-002"]) },
    },
    hourDistribution: Array(24).fill(0),
    entries: [
      dialogEntry({ ts: "2026-04-05T10:00:00Z", project: "-Users-test-project-a", content: "first msg" }),
      dialogEntry({ ts: "2026-04-05T11:00:00Z", project: "-Users-test-project-a", content: "second msg" }),
      dialogEntry({ ts: "2026-04-05T14:00:00Z", project: "-Users-test-project-b", content: "third msg" }),
    ],
  };

  const report = formatDailyReport(stats);
  assert(report.includes("2026-04-05"), "report contains date");
  assert(report.includes("5"), "report contains total message count");
  assert(report.includes("-Users-test-project-a"), "report contains project-a name");
  assert(report.includes("-Users-test-project-b"), "report contains project-b name");
}

async function testFormatDailyReportTimeline(): Promise<void> {
  console.log("\n## formatDailyReport — timeline");

  const stats: DailyStats = {
    date: "2026-04-05",
    totalMessages: 3,
    totalSessions: 1,
    projects: {
      "project-x": { messages: 3, sessions: new Set(["s1"]) },
    },
    hourDistribution: Array(24).fill(0),
    entries: [
      dialogEntry({ ts: "2026-04-05T14:00:00Z", project: "project-x", content: "later message" }),
      dialogEntry({ ts: "2026-04-05T09:00:00Z", project: "project-x", content: "early message" }),
      dialogEntry({ ts: "2026-04-05T12:00:00Z", project: "project-x", content: "mid message" }),
    ],
  };

  const report = formatDailyReport(stats);
  // Timeline should contain message summaries
  assert(report.includes("early message"), "timeline includes early message");
  assert(report.includes("later message"), "timeline includes later message");
  // Timeline should be sorted by time: early before later
  const earlyIdx = report.indexOf("early message");
  const laterIdx = report.indexOf("later message");
  assert(earlyIdx < laterIdx, "timeline sorted: early message before later message");
}

// --- DialogRecorder node tests ---

async function testGetCommands(): Promise<void> {
  console.log("\n## DialogRecorder.getCommands");

  const recorder = new DialogRecorder();
  const commands = recorder.getCommands();
  const names = Object.keys(commands).sort();
  assertEq(names, ["report", "scan", "status"], "getCommands returns status, scan, report");
  assert(!!commands["status"].description, "status has description");
  assert(!!commands["scan"].description, "scan has description");
  assert(!!commands["report"].description, "report has description");
}

async function testGetEvents(): Promise<void> {
  console.log("\n## DialogRecorder.getEvents");

  const recorder = new DialogRecorder();
  const events = recorder.getEvents();
  assertEq(events, ["dialog-recorder.scan_complete"], "getEvents returns dialog-recorder.scan_complete");
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Dialog Recorder — Scanner + Reporter + Node Tests ===");

  try { await testExtractUserMessages(); } catch (e) { failed++; failures.push(`extractUserMessages threw: ${e}`); console.log(`  ✗ extractUserMessages threw: ${e}`); }
  try { await testCleanContent(); } catch (e) { failed++; failures.push(`cleanContent threw: ${e}`); console.log(`  ✗ cleanContent threw: ${e}`); }
  try { await testScanProjects(); } catch (e) { failed++; failures.push(`scanProjects threw: ${e}`); console.log(`  ✗ scanProjects threw: ${e}`); }
  try { await testExtractEmptyFile(); } catch (e) { failed++; failures.push(`extractEmptyFile threw: ${e}`); console.log(`  ✗ extractEmptyFile threw: ${e}`); }
  try { await testExtractCorruptedLines(); } catch (e) { failed++; failures.push(`extractCorruptedLines threw: ${e}`); console.log(`  ✗ extractCorruptedLines threw: ${e}`); }
  try { await testExtractArrayContent(); } catch (e) { failed++; failures.push(`extractArrayContent threw: ${e}`); console.log(`  ✗ extractArrayContent threw: ${e}`); }
  try { await testExtractNullContent(); } catch (e) { failed++; failures.push(`extractNullContent threw: ${e}`); console.log(`  ✗ extractNullContent threw: ${e}`); }
  try { await testScanNonexistentDir(); } catch (e) { failed++; failures.push(`scanNonexistentDir threw: ${e}`); console.log(`  ✗ scanNonexistentDir threw: ${e}`); }
  try { await testExtractEmptyContent(); } catch (e) { failed++; failures.push(`extractEmptyContent threw: ${e}`); console.log(`  ✗ extractEmptyContent threw: ${e}`); }
  try { await testAggregateDailyStats(); } catch (e) { failed++; failures.push(`aggregateDailyStats threw: ${e}`); console.log(`  ✗ aggregateDailyStats threw: ${e}`); }
  try { await testAggregateDailyStatsHourDistribution(); } catch (e) { failed++; failures.push(`aggregateDailyStatsHour threw: ${e}`); console.log(`  ✗ aggregateDailyStatsHour threw: ${e}`); }
  try { await testAggregateDailyStatsNoData(); } catch (e) { failed++; failures.push(`aggregateDailyStatsNoData threw: ${e}`); console.log(`  ✗ aggregateDailyStatsNoData threw: ${e}`); }
  try { await testAggregateDailyStatsFileNotExist(); } catch (e) { failed++; failures.push(`aggregateDailyStatsFileNotExist threw: ${e}`); console.log(`  ✗ aggregateDailyStatsFileNotExist threw: ${e}`); }
  try { await testFormatDailyReport(); } catch (e) { failed++; failures.push(`formatDailyReport threw: ${e}`); console.log(`  ✗ formatDailyReport threw: ${e}`); }
  try { await testFormatDailyReportTimeline(); } catch (e) { failed++; failures.push(`formatDailyReportTimeline threw: ${e}`); console.log(`  ✗ formatDailyReportTimeline threw: ${e}`); }
  try { await testGetCommands(); } catch (e) { failed++; failures.push(`getCommands threw: ${e}`); console.log(`  ✗ getCommands threw: ${e}`); }
  try { await testGetEvents(); } catch (e) { failed++; failures.push(`getEvents threw: ${e}`); console.log(`  ✗ getEvents threw: ${e}`); }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
