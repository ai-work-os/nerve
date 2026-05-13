#!/usr/bin/env npx tsx
/**
 * Harness phase 1 — event log integration tests (red)
 *
 * Run: npx tsx test/harness-phase1-event-log.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14821;
const TEST_DATA = resolve(ROOT, ".test-data-harness-phase1");
const EVENT_LOG = resolve(TEST_DATA, "events.jsonl");

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
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true, force: true });

  serverProc = spawn("npx", [
    "tsx",
    "src/index.ts",
    "--port", String(TEST_PORT),
    "--data", TEST_DATA,
    "--event-log", EVENT_LOG,
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stdout!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("started on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.toLowerCase().includes("error")) {
        process.stderr.write(`[server] ${s}`);
      }
    });
    serverProc!.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    serverProc!.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) reject(new Error(`server exited with code ${code}`));
    });
  });
}

function stopServer(): void {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error("wait timeout");
}

type EventEntry = {
  ts: string;
  event: string;
  [key: string]: unknown;
};

function readEvents(): EventEntry[] {
  if (!existsSync(EVENT_LOG)) return [];
  const content = readFileSync(EVENT_LOG, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map(line => JSON.parse(line));
}

function findEvent(events: EventEntry[], event: string, predicate: (entry: EventEntry) => boolean): EventEntry | undefined {
  return events.find(entry => entry.event === event && predicate(entry));
}

async function setupScenario() {
  const alice = new WsClient();
  const bob = new WsClient();
  await alice.connect();
  await bob.connect();

  const aliceReg = await alice.request("node.register", { name: "alice", capabilities: ["ui"] });
  const bobReg = await bob.request("node.register", { name: "bob", capabilities: ["ui"] });

  const channel = await alice.request("channel.create", { cwd: ROOT, name: "phase1-red" });
  await alice.request("channel.join", { channelId: channel.channelId });
  await bob.request("channel.join", { channelId: channel.channelId });
  await alice.request("channel.post", { channelId: channel.channelId, content: "@bob ping ws" });

  const proc = await alice.request("node.spawn", { adapter: "mock", name: "mock-phase1", cwd: ROOT });
  await waitFor(() => {
    const events = readEvents();
    return events.some(e => e.event === "node.statusChanged" && e.name === "mock-phase1" && e.status === "idle");
  }).catch(() => {});

  await alice.request("channel.addNode", {
    channelId: channel.channelId,
    nodeId: proc.nodeId,
    nodeName: "mock-phase1",
  });
  await alice.request("channel.post", { channelId: channel.channelId, content: "@mock-phase1 ping process" });
  await sleep(4000);
  await alice.request("node.stop", { nodeId: proc.nodeId });
  await sleep(1000);

  return {
    alice,
    bob,
    channelId: channel.channelId as string,
    aliceNodeId: aliceReg.nodeId as string,
    bobNodeId: bobReg.nodeId as string,
    procNodeId: proc.nodeId as string,
  };
}

async function testEventLogFileCreated() {
  console.log("\n▸ event log file is created when --event-log is set");
  assert(existsSync(EVENT_LOG), "event log file exists", EVENT_LOG);
  const events = readEvents();
  assert(events.length > 0, "event log has at least one event");
}

async function testNodeLifecycleEvents(procNodeId: string) {
  console.log("\n▸ node lifecycle events are written to JSONL");
  const events = readEvents();
  assert(!!findEvent(events, "node.registered", e => e.name === "mock-phase1"), "node.registered logged for process node");
  assert(!!findEvent(events, "node.statusChanged", e => e.name === "mock-phase1" && e.status === "idle"), "node.statusChanged idle logged");
  assert(!!findEvent(events, "node.stopped", e => e.nodeId === procNodeId), "node.stopped logged");
}

async function testChannelJoinLeaveAndMessage(channelId: string, bobNodeId: string) {
  console.log("\n▸ channel join/leave/message events are written");
  const events = readEvents();
  assert(!!findEvent(events, "channel.created", e => e.channelId === channelId), "channel.created logged");
  assert(!!findEvent(events, "channel.nodeJoined", e => e.channelId === channelId && e.nodeId === bobNodeId), "channel.nodeJoined logged");
  assert(!!findEvent(events, "channel.message", e => e.channelId === channelId && e.content === "@bob ping ws"), "channel.message logged");
  assert(!!findEvent(events, "channel.nodeLeft", e => e.channelId === channelId && e.nodeId === bobNodeId), "channel.nodeLeft logged for ws leave");
}

async function testMentionDeliveryAndDm(channelId: string, bobNodeId: string, procNodeId: string) {
  console.log("\n▸ ws/process mention delivery and dm events are written");
  const events = readEvents();

  assert(!!findEvent(events, "channel.mention", e =>
    e.channelId === channelId &&
    e.targetNodeId === bobNodeId &&
    e.delivery === "ws_notification"
  ), "ws mention logged with ws_notification");

  assert(!!findEvent(events, "channel.mention", e =>
    e.channelId === channelId &&
    e.targetNodeId === procNodeId &&
    e.delivery === "direct_prompt"
  ), "process mention logged with direct_prompt");

  assert(!!findEvent(events, "dm.prompt", e => e.targetNodeId === procNodeId), "dm.prompt logged");
  assert(!!findEvent(events, "dm.response", e => e.targetNodeId === procNodeId), "dm.response logged");
}

async function testOrderingAndJsonValidity(procNodeId: string) {
  console.log("\n▸ JSONL is valid and channel.nodeLeft precedes node.stopped");
  const events = readEvents();
  assert(events.length > 0, "events can be parsed as JSON");
  assert(events.every(e => typeof e.ts === "string" && typeof e.event === "string"), "every event has ts and event");

  const leftIndex = events.findIndex(e => e.event === "channel.nodeLeft" && e.nodeId === procNodeId);
  const stoppedIndex = events.findIndex(e => e.event === "node.stopped" && e.nodeId === procNodeId);
  assert(leftIndex >= 0, "channel.nodeLeft exists for stopped process node");
  assert(stoppedIndex >= 0, "node.stopped exists for stopped process node");
  assert(leftIndex >= 0 && stoppedIndex >= 0 && leftIndex < stoppedIndex, "channel.nodeLeft occurs before node.stopped");
}

async function main() {
  console.log("════════════════════════════════════════════");
  console.log("  Harness Phase 1 Event Log Tests (Red)");
  console.log("════════════════════════════════════════════");

  try {
    await startServer();
    const scenario = await setupScenario();

    await scenario.bob.disconnect();
    await sleep(300);

    await testEventLogFileCreated();
    await testNodeLifecycleEvents(scenario.procNodeId);
    await testChannelJoinLeaveAndMessage(scenario.channelId, scenario.bobNodeId);
    await testMentionDeliveryAndDm(scenario.channelId, scenario.bobNodeId, scenario.procNodeId);
    await testOrderingAndJsonValidity(scenario.procNodeId);

    await scenario.alice.disconnect();
  } catch (err: any) {
    failed++;
    failures.push(`test harness crashed: ${err.message}`);
    console.log(`  ✗ test harness crashed — ${err.message}`);
  } finally {
    stopServer();
  }

  console.log("\n════════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
