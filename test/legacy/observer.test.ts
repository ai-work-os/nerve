#!/usr/bin/env npx tsx
/**
 * Observer Plugin Tests (TDD)
 *
 * Phase 1: event collection + auto-join channels.
 * Phase 2: stats aggregation + report generation + commands.
 * Run: npx tsx test/observer.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-observer");

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

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// UNIT TESTS — pure logic, no server needed
// ============================================================

import {
  formatChannelMessage,
  formatNodeRegistered,
  formatNodeStopped,
  formatNodeStatusChanged,
  type ObserverEvent,
} from "../../src/plugins/observer/events.js";

import {
  readDayEvents,
  readDateRange,
  aggregateStats,
  formatDailyReport,
  formatWeeklyReport,
  type DailyStats,
} from "../../src/plugins/observer/stats.js";

function testFormatChannelMessage() {
  console.log("\n▸ formatChannelMessage: structures channel.message params");

  const event = formatChannelMessage({
    channelId: "abc123",
    channelName: "fix-bug",
    message: {
      from: "fix-lead",
      content: "@coder-1 任务完成",
      metadata: { nodeType: "stdio" },
    },
  });

  assertEq(event.type, "channel.message", "type is channel.message");
  assert(!!event.ts, "has timestamp");
  assertEq(event.ch, "abc123", "has channel id");
  assertEq(event.chName, "fix-bug", "has channel name");
  assertEq(event.from, "fix-lead", "has sender");
  assertEq(event.fromType, "stdio", "has sender type");
  assertEq(event.content, "@coder-1 任务完成", "has content");
}

function testFormatNodeRegistered() {
  console.log("\n▸ formatNodeRegistered: structures node.registered params");

  const event = formatNodeRegistered({
    nodeId: "id-1",
    name: "coder-1",
    adapter: "claude",
    transport: "stdio",
  });

  assertEq(event.type, "node.registered", "type is node.registered");
  assert(!!event.ts, "has timestamp");
  assertEq(event.node, "coder-1", "has node name");
  assertEq(event.adapter, "claude", "has adapter");
  assertEq(event.transport, "stdio", "has transport");
}

function testFormatNodeStopped() {
  console.log("\n▸ formatNodeStopped: structures node.stopped params");

  const event = formatNodeStopped({
    nodeId: "id-1",
    name: "coder-1",
    exitCode: 0,
  });

  assertEq(event.type, "node.stopped", "type is node.stopped");
  assertEq(event.node, "coder-1", "has node name");
  assertEq(event.exitCode, 0, "has exit code");
}

function testFormatNodeStoppedNullExitCode() {
  console.log("\n▸ formatNodeStopped: handles null exitCode");

  const event = formatNodeStopped({
    nodeId: "id-2",
    name: "coder-2",
    exitCode: null,
  });

  assertEq(event.exitCode, null, "exitCode is null");
}

function testFormatNodeStatusChanged() {
  console.log("\n▸ formatNodeStatusChanged: structures node.statusChanged params");

  const event = formatNodeStatusChanged({
    nodeId: "id-1",
    name: "coder-1",
    status: "busy",
    activity: "thinking",
  });

  assertEq(event.type, "node.statusChanged", "type is node.statusChanged");
  assertEq(event.node, "coder-1", "has node name");
  assertEq(event.status, "busy", "has status");
  assertEq(event.activity, "thinking", "has activity");
}

function testFormatNodeStatusChangedNoActivity() {
  console.log("\n▸ formatNodeStatusChanged: handles missing activity");

  const event = formatNodeStatusChanged({
    nodeId: "id-1",
    name: "coder-1",
    status: "idle",
  });

  assertEq(event.status, "idle", "has status");
  assert(event.activity === undefined, "activity is undefined");
}

// ============================================================
// PHASE 2 UNIT TESTS — stats aggregation + report formatting
// ============================================================

const STATS_TEST_DIR = resolve(ROOT, ".test-stats-events");

function setupStatsTestDir() {
  if (existsSync(STATS_TEST_DIR)) rmSync(STATS_TEST_DIR, { recursive: true });
  mkdirSync(STATS_TEST_DIR, { recursive: true });
}

function cleanupStatsTestDir() {
  if (existsSync(STATS_TEST_DIR)) rmSync(STATS_TEST_DIR, { recursive: true });
}

function writeTestEvents(date: string, events: ObserverEvent[]) {
  const path = resolve(STATS_TEST_DIR, `${date}.jsonl`);
  const content = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, content);
}

async function testReadDayEventsEmpty() {
  console.log("\n▸ readDayEvents: returns empty for missing file");
  const events = await readDayEvents(STATS_TEST_DIR, "2026-01-01");
  assertEq(events.length, 0, "no events for missing date");
}

async function testReadDayEventsWithData() {
  console.log("\n▸ readDayEvents: reads JSONL correctly");
  const testEvents: ObserverEvent[] = [
    { ts: "2026-04-02T10:00:00Z", type: "channel.message", ch: "ch1", chName: "test", from: "alice", content: "hello" },
    { ts: "2026-04-02T10:01:00Z", type: "node.registered", node: "bob", adapter: "claude", transport: "stdio" },
    { ts: "2026-04-02T10:02:00Z", type: "node.stopped", node: "bob", exitCode: 0 },
  ];
  writeTestEvents("2026-04-02", testEvents);

  const events = await readDayEvents(STATS_TEST_DIR, "2026-04-02");
  assertEq(events.length, 3, "reads 3 events");
  assertEq(events[0].type, "channel.message", "first event is message");
  assertEq(events[2].type, "node.stopped", "third event is stopped");
}

async function testReadDayEventsSkipsMalformed() {
  console.log("\n▸ readDayEvents: skips malformed lines");
  const path = resolve(STATS_TEST_DIR, "2026-04-03.jsonl");
  writeFileSync(path, '{"ts":"2026-04-03T10:00:00Z","type":"channel.message"}\nNOT JSON\n{"ts":"2026-04-03T11:00:00Z","type":"node.registered"}\n');

  const events = await readDayEvents(STATS_TEST_DIR, "2026-04-03");
  assertEq(events.length, 2, "skips malformed line, reads 2");
}

function testAggregateStatsBasic() {
  console.log("\n▸ aggregateStats: basic counts");
  const events: ObserverEvent[] = [
    { ts: "2026-04-02T09:00:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "alice", fromType: "websocket", content: "start" },
    { ts: "2026-04-02T09:01:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "bob", fromType: "stdio", content: "ok" },
    { ts: "2026-04-02T09:02:00Z", type: "channel.message", ch: "ch2", chName: "impl", from: "alice", fromType: "websocket", content: "go" },
    { ts: "2026-04-02T10:00:00Z", type: "node.registered", node: "bob", adapter: "claude", transport: "stdio" },
    { ts: "2026-04-02T10:01:00Z", type: "node.statusChanged", node: "bob", status: "busy", activity: "thinking" },
    { ts: "2026-04-02T10:02:00Z", type: "node.statusChanged", node: "bob", status: "idle" },
    { ts: "2026-04-02T11:00:00Z", type: "node.stopped", node: "bob", exitCode: 0 },
  ];

  const stats = aggregateStats(events, "2026-04-02");

  assertEq(stats.totalEvents, 7, "total events");
  assertEq(stats.messageCount, 3, "message count");
  assertEq(stats.nodeRegistered, 1, "node registered");
  assertEq(stats.nodeStopped, 1, "node stopped");
  assertEq(stats.statusChanges, 2, "status changes");
  assertEq(stats.channels.size, 2, "2 channels");
  assertEq(stats.agents.size, 2, "2 agents");
}

function testAggregateStatsChannelDetails() {
  console.log("\n▸ aggregateStats: channel details");
  const events: ObserverEvent[] = [
    { ts: "2026-04-02T09:00:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "alice", content: "a" },
    { ts: "2026-04-02T09:01:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "bob", content: "b" },
    { ts: "2026-04-02T09:02:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "alice", content: "c" },
  ];

  const stats = aggregateStats(events, "2026-04-02");
  const ch = stats.channels.get("ch1");
  assert(!!ch, "channel ch1 exists");
  assertEq(ch!.messageCount, 3, "ch1 has 3 messages");
  assertEq(ch!.participants.size, 2, "ch1 has 2 participants");
  assert(ch!.participants.has("alice"), "alice is participant");
  assert(ch!.participants.has("bob"), "bob is participant");
}

function testAggregateStatsAgentDetails() {
  console.log("\n▸ aggregateStats: agent lifecycle tracking");
  const events: ObserverEvent[] = [
    { ts: "2026-04-02T10:00:00Z", type: "node.registered", node: "coder", adapter: "claude", transport: "stdio" },
    { ts: "2026-04-02T10:01:00Z", type: "node.statusChanged", node: "coder", status: "busy" },
    { ts: "2026-04-02T10:02:00Z", type: "channel.message", ch: "ch1", chName: "work", from: "coder", content: "done" },
    { ts: "2026-04-02T10:03:00Z", type: "node.stopped", node: "coder", exitCode: 0 },
  ];

  const stats = aggregateStats(events, "2026-04-02");
  const agent = stats.agents.get("coder");
  assert(!!agent, "agent coder exists");
  assertEq(agent!.wasSpawned, true, "coder was spawned");
  assertEq(agent!.wasStopped, true, "coder was stopped");
  assertEq(agent!.messageCount, 1, "coder sent 1 message");
  assertEq(agent!.statusChanges, 1, "coder had 1 status change");
}

function testAggregateStatsHourlyDistribution() {
  console.log("\n▸ aggregateStats: hourly message distribution (local time)");
  // Use local time strings to avoid UTC/local mismatch
  const d = new Date(2026, 3, 2, 9, 0, 0); // April 2, 2026 09:00 local
  const d2 = new Date(2026, 3, 2, 9, 30, 0); // 09:30 local
  const d3 = new Date(2026, 3, 2, 14, 0, 0); // 14:00 local
  const events: ObserverEvent[] = [
    { ts: d.toISOString(), type: "channel.message", ch: "ch1", from: "a", content: "1" },
    { ts: d2.toISOString(), type: "channel.message", ch: "ch1", from: "a", content: "2" },
    { ts: d3.toISOString(), type: "channel.message", ch: "ch1", from: "a", content: "3" },
  ];

  const stats = aggregateStats(events, "2026-04-02");
  assertEq(stats.hourlyMessages[9], 2, "2 messages at local hour 9");
  assertEq(stats.hourlyMessages[14], 1, "1 message at local hour 14");
  assertEq(stats.hourlyMessages[0], 0, "0 messages at hour 0");
}

function testAggregateStatsEmpty() {
  console.log("\n▸ aggregateStats: empty events");
  const stats = aggregateStats([], "2026-04-02");
  assertEq(stats.totalEvents, 0, "0 total events");
  assertEq(stats.channels.size, 0, "0 channels");
  assertEq(stats.agents.size, 0, "0 agents");
}

function testFormatDailyReport() {
  console.log("\n▸ formatDailyReport: generates valid markdown");
  const events: ObserverEvent[] = [
    { ts: "2026-04-02T09:00:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "alice", content: "start" },
    { ts: "2026-04-02T09:01:00Z", type: "node.registered", node: "bob" },
  ];
  const stats = aggregateStats(events, "2026-04-02");
  const report = formatDailyReport(stats);

  assert(report.startsWith("# 日报 — 2026-04-02"), "starts with title");
  assert(report.includes("总事件: 2"), "contains total events");
  assert(report.includes("频道消息: 1"), "contains message count");
  assert(report.includes("design"), "contains channel name");
  assert(report.includes("alice"), "contains agent name");
}

function testFormatWeeklyReport() {
  console.log("\n▸ formatWeeklyReport: generates valid markdown");
  const day1 = aggregateStats([
    { ts: "2026-04-01T09:00:00Z", type: "channel.message", ch: "ch1", from: "alice", content: "a" },
  ], "2026-04-01");
  const day2 = aggregateStats([
    { ts: "2026-04-02T09:00:00Z", type: "channel.message", ch: "ch1", from: "alice", content: "b" },
    { ts: "2026-04-02T10:00:00Z", type: "channel.message", ch: "ch1", from: "bob", content: "c" },
  ], "2026-04-02");

  const report = formatWeeklyReport([day1, day2], "2026-W14");

  assert(report.startsWith("# 周报 — 2026-W14"), "starts with title");
  assert(report.includes("活跃天数: 2/7"), "contains active days");
  assert(report.includes("频道消息: 3"), "contains total messages");
  assert(report.includes("alice"), "contains top agent");
}

async function testReadDateRangeLocalDates() {
  console.log("\n▸ readDateRange: iterates local dates correctly");
  // Write events for 3 consecutive days
  writeTestEvents("2026-04-01", [
    { ts: "2026-04-01T01:00:00Z", type: "channel.message", from: "a", content: "day1" },
  ]);
  writeTestEvents("2026-04-02", [
    { ts: "2026-04-02T01:00:00Z", type: "channel.message", from: "a", content: "day2-1" },
    { ts: "2026-04-02T02:00:00Z", type: "channel.message", from: "b", content: "day2-2" },
  ]);
  writeTestEvents("2026-04-03", [
    { ts: "2026-04-03T01:00:00Z", type: "channel.message", from: "a", content: "day3" },
  ]);

  const events = await readDateRange(STATS_TEST_DIR, "2026-04-01", "2026-04-03");
  assertEq(events.length, 4, "reads all 4 events across 3 days");

  // Partial range
  const partial = await readDateRange(STATS_TEST_DIR, "2026-04-02", "2026-04-02");
  assertEq(partial.length, 2, "single day range reads 2 events");

  // Range with missing day
  const withGap = await readDateRange(STATS_TEST_DIR, "2026-04-01", "2026-04-05");
  assertEq(withGap.length, 4, "range with missing days still reads available events");
}

function testFormatDailyReportSetSerialization() {
  console.log("\n▸ formatDailyReport: Set fields serialize correctly (not [object Set])");
  const events: ObserverEvent[] = [
    { ts: "2026-04-02T09:00:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "alice", content: "a" },
    { ts: "2026-04-02T09:01:00Z", type: "channel.message", ch: "ch1", chName: "design", from: "bob", content: "b" },
  ];
  const stats = aggregateStats(events, "2026-04-02");
  const report = formatDailyReport(stats);

  // Participants should appear as comma-separated names, not [object Set]
  assert(!report.includes("[object Set]"), "no [object Set] in report");
  assert(report.includes("alice"), "alice appears in participants");
  assert(report.includes("bob"), "bob appears in participants");
}

function testFormatDailyReportEmpty() {
  console.log("\n▸ formatDailyReport: empty day produces valid report");
  const stats = aggregateStats([], "2026-04-02");
  const report = formatDailyReport(stats);
  assert(report.includes("# 日报"), "has title");
  assert(report.includes("总事件: 0"), "shows 0 events");
  assert(!report.includes("频道活跃度"), "no channel section for empty day");
}

// ============================================================
// INTEGRATION TESTS — with real server
// ============================================================

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this.ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && !msg.method) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } else if (msg.method) {
            this.notifications.push({ method: msg.method, params: msg.params });
          }
        });
        resolve();
      });
      this.ws.on("error", reject);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  getNotifications(method?: string): Array<{ method: string; params: any }> {
    if (method) return this.notifications.filter(n => n.method === method);
    return this.notifications;
  }

  clearNotifications(): void {
    this.notifications = [];
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR")) process.stderr.write(`[server] ${s}`);
    });
    serverProc!.stdout!.on("data", (d) => {
      if (d.toString().includes("started on port")) { clearTimeout(timeout); resolve(); }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

function stopServer(): void {
  if (serverProc) { serverProc.kill("SIGTERM"); serverProc = null; }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

// --- Integration: Observer registers and receives broadcasts ---

async function testObserverRegisters() {
  console.log("\n▸ Observer: registers as observer node");
  const c = new WsClient();
  await c.connect();

  const reg = await c.request("node.register", {
    name: "observer",
    capabilities: ["monitor"],
    permissions: "observer",
  });
  assert(!!reg.nodeId, "observer registers successfully");
  assertEq(reg.name, "observer", "observer has correct name");

  const list = await c.request("node.list");
  const obs = list.nodes?.find((n: any) => n.name === "observer");
  assert(!!obs, "observer appears in node list");
  assertEq(obs.permissions, "observer", "observer has observer permissions");

  await c.disconnect();
}

async function testObserverReceivesChannelCreated() {
  console.log("\n▸ Observer: receives channel.created broadcast");
  const obs = new WsClient();
  await obs.connect();
  await obs.request("node.register", { name: "obs-ch-test", capabilities: ["monitor"], permissions: "observer" });

  obs.clearNotifications();

  // Another client creates a channel
  const other = new WsClient();
  await other.connect();
  await other.request("node.register", { name: "creator", capabilities: ["ui"] });
  const ch = await other.request("channel.create", { cwd: ROOT, name: "test-ch-1" });

  await sleep(200);

  // Observer should have received channel.created
  const created = obs.getNotifications("channel.created");
  assert(created.length >= 1, "observer received channel.created notification");
  if (created.length > 0) {
    assertEq(created[0].params.channelId, ch.channelId, "channel.created has correct channelId");
    assertEq(created[0].params.name, "test-ch-1", "channel.created has channel name");
  }

  await other.disconnect();
  await obs.disconnect();
}

async function testObserverAutoJoinsAndReceivesMessages() {
  console.log("\n▸ Observer: auto-joins channel and receives messages");

  // 1. Observer connects and registers
  const obs = new WsClient();
  await obs.connect();
  await obs.request("node.register", { name: "obs-join-test", capabilities: ["monitor"], permissions: "observer" });

  // 2. Another node creates a channel
  const agent = new WsClient();
  await agent.connect();
  await agent.request("node.register", { name: "agent-msg", capabilities: ["ui"] });
  const ch = await agent.request("channel.create", { cwd: ROOT, name: "msg-ch" });

  // 3. Observer joins the channel (simulating auto-join behavior)
  await obs.request("channel.join", { channelId: ch.channelId });
  await agent.request("channel.join", { channelId: ch.channelId });

  obs.clearNotifications();

  // 4. Agent posts a message
  await agent.request("channel.post", {
    channelId: ch.channelId,
    content: "hello from agent",
  });

  await sleep(200);

  // 5. Observer should have received channel.message
  const msgs = obs.getNotifications("channel.message");
  assert(msgs.length >= 1, "observer received channel.message");
  if (msgs.length > 0) {
    assert(msgs[0].params.message?.content === "hello from agent" || msgs[0].params.content === "hello from agent",
      "message content matches");
  }

  await agent.disconnect();
  await obs.disconnect();
}

async function testObserverReceivesNodeLifecycle() {
  console.log("\n▸ Observer: receives node lifecycle broadcasts");

  const obs = new WsClient();
  await obs.connect();
  await obs.request("node.register", { name: "obs-lifecycle", capabilities: ["monitor"], permissions: "observer" });

  obs.clearNotifications();

  // Spawn a mock agent (stdio process) — these emit both node.registered and node.stopped
  const spawned = await obs.request("node.spawn", { adapter: "mock", name: "lifecycle-agent", cwd: ROOT });
  await sleep(2000);

  // Observer should receive node.registered
  const registered = obs.getNotifications("node.registered");
  const found = registered.find(n => n.params.name === "lifecycle-agent");
  assert(!!found, "observer received node.registered for lifecycle-agent");

  // Stop the agent → observer should receive node.stopped
  await obs.request("node.stop", { nodeId: spawned.nodeId });
  await sleep(1500);

  const stopped = obs.getNotifications("node.stopped");
  const stoppedFound = stopped.find(n => n.params.name === "lifecycle-agent");
  assert(!!stoppedFound, "observer received node.stopped for lifecycle-agent");

  await obs.disconnect();
}

async function testObserverCanListExistingChannels() {
  console.log("\n▸ Observer: can list existing channels on startup");

  // Create a channel first
  const setup = new WsClient();
  await setup.connect();
  await setup.request("node.register", { name: "setup-node", capabilities: ["ui"] });
  const ch = await setup.request("channel.create", { cwd: ROOT, name: "existing-ch" });

  // Now observer connects and lists channels
  const obs = new WsClient();
  await obs.connect();
  await obs.request("node.register", { name: "obs-list-test", capabilities: ["monitor"], permissions: "observer" });

  const list = await obs.request("channel.list");
  assert(Array.isArray(list.channels), "channel.list returns array");
  const existing = list.channels?.find((c: any) => c.name === "existing-ch");
  assert(!!existing, "existing channel appears in list");

  // Observer can join it
  const joinResult = await obs.request("channel.join", { channelId: ch.channelId });
  assert(!!joinResult, "observer successfully joined existing channel");

  await setup.disconnect();
  await obs.disconnect();
}

// --- Integration: Observer plugin process records events ---

async function testObserverPluginRecordsEvents() {
  console.log("\n▸ Observer plugin: records channel messages to JSONL");

  // Use isolated temp directory for observer data via HOME override
  const observerHome = resolve(ROOT, ".test-observer-home");
  if (existsSync(observerHome)) rmSync(observerHome, { recursive: true });
  mkdirSync(observerHome, { recursive: true });

  // Start the observer plugin as a subprocess with isolated HOME
  const observerProc = spawn("npx", ["tsx", "src/plugins/observer/index.ts", "--port", String(TEST_PORT)], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: observerHome },
  });

  // Wait for observer to connect and register
  await sleep(3000);

  // Create a channel and post a message
  const client = new WsClient();
  await client.connect();
  await client.request("node.register", { name: "test-poster", capabilities: ["ui"] });
  const ch = await client.request("channel.create", { cwd: ROOT, name: "observer-test-ch" });
  await client.request("channel.join", { channelId: ch.channelId });

  // Give observer time to auto-join the new channel
  await sleep(1000);

  await client.request("channel.post", {
    channelId: ch.channelId,
    content: "test message for observer",
  });

  // Wait for observer to write the event
  await sleep(1000);

  // Check JSONL file in isolated directory
  const today = new Date().toISOString().slice(0, 10);
  const eventsDir = resolve(observerHome, `.nerve/plugins/observer/events`);
  const jsonlPath = resolve(eventsDir, `${today}.jsonl`);

  let found = false;
  if (existsSync(jsonlPath)) {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Verify events are in order (timestamps non-decreasing)
    let lastTs = "";
    let orderOk = true;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.ts < lastTs) orderOk = false;
        lastTs = event.ts;
        if (event.type === "channel.message" && event.content === "test message for observer") {
          found = true;
          assertEq(event.chName, "observer-test-ch", "recorded event has channel name");
          assertEq(event.from, "test-poster", "recorded event has sender");
        }
      } catch { /* skip malformed lines */ }
    }
    assert(orderOk, "events are in chronological order");
  }
  assert(found, "observer recorded channel.message to JSONL file");

  // Cleanup
  observerProc.kill("SIGTERM");
  await sleep(500); // let flush complete
  await client.disconnect();
  if (existsSync(observerHome)) rmSync(observerHome, { recursive: true });
}

// --- Integration: Observer commands (status, report) ---

async function testObserverStatusCommand() {
  console.log("\n▸ Observer plugin: status command via @mention");

  const observerHome = resolve(ROOT, ".test-observer-home-cmd");
  if (existsSync(observerHome)) rmSync(observerHome, { recursive: true });
  mkdirSync(observerHome, { recursive: true });

  const observerProc = spawn("npx", ["tsx", "src/plugins/observer/index.ts", "--port", String(TEST_PORT)], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: observerHome },
  });

  // Capture observer stdout for status output
  let observerOutput = "";
  observerProc.stdout!.on("data", (d) => { observerOutput += d.toString(); });
  observerProc.stderr!.on("data", (d) => { observerOutput += d.toString(); });

  await sleep(3000);

  // Create a channel and add observer + a test client
  const client = new WsClient();
  await client.connect();
  await client.request("node.register", { name: "cmd-tester", capabilities: ["ui"] });
  const ch = await client.request("channel.create", { cwd: ROOT, name: "cmd-test-ch" });
  await client.request("channel.join", { channelId: ch.channelId });

  await sleep(1000); // let observer auto-join

  // Send a few messages first
  await client.request("channel.post", { channelId: ch.channelId, content: "msg 1" });
  await client.request("channel.post", { channelId: ch.channelId, content: "msg 2" });
  await sleep(500);

  // Send @observer status command
  observerOutput = ""; // clear
  await client.request("channel.post", { channelId: ch.channelId, content: "@observer status" });
  await sleep(1000);

  // Observer should have logged status info
  assert(observerOutput.includes("events collected") || observerOutput.includes("status"), "observer responded to status command");

  // Send @observer report daily command
  observerOutput = "";
  await client.request("channel.post", { channelId: ch.channelId, content: "@observer report daily" });
  await sleep(2000);

  // Check report file was created
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = resolve(observerHome, `.nerve/plugins/observer/reports/daily-${today}.md`);
  assert(existsSync(reportPath), "daily report file created");
  if (existsSync(reportPath)) {
    const report = readFileSync(reportPath, "utf-8");
    assert(report.includes("# 日报"), "report contains title");
    assert(report.includes("频道消息"), "report contains message stats");
  }

  // Cleanup
  observerProc.kill("SIGTERM");
  await sleep(500);
  await client.disconnect();
  if (existsSync(observerHome)) rmSync(observerHome, { recursive: true });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Observer Plugin Tests");
  console.log("═══════════════════════════════════════");

  // Phase 1 unit tests
  testFormatChannelMessage();
  testFormatNodeRegistered();
  testFormatNodeStopped();
  testFormatNodeStoppedNullExitCode();
  testFormatNodeStatusChanged();
  testFormatNodeStatusChangedNoActivity();

  // Phase 2 unit tests — stats
  setupStatsTestDir();
  try {
    await testReadDayEventsEmpty();
    await testReadDayEventsWithData();
    await testReadDayEventsSkipsMalformed();
    testAggregateStatsBasic();
    testAggregateStatsChannelDetails();
    testAggregateStatsAgentDetails();
    testAggregateStatsHourlyDistribution();
    testAggregateStatsEmpty();
    testFormatDailyReport();
    testFormatWeeklyReport();
    await testReadDateRangeLocalDates();
    testFormatDailyReportSetSerialization();
    testFormatDailyReportEmpty();
  } finally {
    cleanupStatsTestDir();
  }

  // Integration tests (need server)
  try {
    console.log("\nStarting server for integration tests...");
    await startServer();
    console.log("Server ready.\n");

    await testObserverRegisters();
    await testObserverReceivesChannelCreated();
    await testObserverAutoJoinsAndReceivesMessages();
    await testObserverReceivesNodeLifecycle();
    await testObserverCanListExistingChannels();
    await testObserverPluginRecordsEvents();
    await testObserverStatusCommand();

  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    stopServer();
  }

  // Summary
  console.log("\n══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    ✗ ${f}`);
    }
  }
  console.log("══════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
