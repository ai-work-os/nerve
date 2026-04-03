#!/usr/bin/env npx tsx
/**
 * Observer Plugin Tests (TDD)
 *
 * Phase 1: event collection + auto-join channels.
 * Run: npx tsx test/observer.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
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
} from "../src/plugins/observer/events.js";

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

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Observer Plugin Tests");
  console.log("═══════════════════════════════════════");

  // Unit tests (no server needed)
  testFormatChannelMessage();
  testFormatNodeRegistered();
  testFormatNodeStopped();
  testFormatNodeStoppedNullExitCode();
  testFormatNodeStatusChanged();
  testFormatNodeStatusChangedNoActivity();

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
