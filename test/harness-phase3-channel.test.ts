#!/usr/bin/env npx tsx
/**
 * Harness phase3 — channel scenarios S1, S6, S7 (red)
 *
 * Run: npx tsx test/harness-phase3-channel.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14830;
const TEST_DATA = resolve(ROOT, ".test-data-harness-phase3-channel");
const EVENT_LOG = resolve(TEST_DATA, "events.jsonl");

let passed = 0;
let failed = 0;
const failures: string[] = [];
const serverOutput: string[] = [];

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
          } else if (msg.method && msg.id === undefined) {
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
    if (!method) return [...this.notifications];
    return this.notifications.filter(n => n.method === method);
  }

  async waitForNotification(method: string, count: number = 1, timeoutMs: number = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getNotifications(method).length >= count) return;
      await sleep(50);
    }
    throw new Error(`timeout waiting for ${count}x ${method} notification`);
  }

  clearNotifications(): void {
    this.notifications = [];
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

type EventEntry = {
  ts: string;
  event: string;
  nodeId?: string;
  channelId?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
};

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
      serverOutput.push(s);
      if (s.includes("started on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc!.stderr!.on("data", (d) => {
      serverOutput.push(d.toString());
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

function readEvents(): EventEntry[] {
  if (!existsSync(EVENT_LOG)) return [];
  const raw = readFileSync(EVENT_LOG, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => JSON.parse(line));
}

function findEvent(events: EventEntry[], event: string, predicate: (e: EventEntry) => boolean): EventEntry | undefined {
  return events.find(e => e.event === event && predicate(e));
}

async function waitForNodeStatus(client: WsClient, nodeId: string, status: string, timeoutMs = 10000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await client.request("node.list");
    const node = list.nodes.find((n: any) => n.id === nodeId);
    if (node?.status === status) return node;
    await sleep(100);
  }
  throw new Error(`timeout waiting for node ${nodeId} -> ${status}`);
}

// ──────────────────────────────────────────────────────────────────────
// S1: Channel create + add nodes
// ──────────────────────────────────────────────────────────────────────

async function testS1_ChannelCreateAndAddNodes() {
  console.log("\n▸ S1: Channel create + add nodes");

  const ts = Date.now();
  const admin = new WsClient();
  const memberA = new WsClient();
  const memberB = new WsClient();

  try {
    await admin.connect();
    await memberA.connect();
    await memberB.connect();

    const adminReg = await admin.request("node.register", { name: `s1-admin-${ts}`, capabilities: ["ui"] });
    const memberAReg = await memberA.request("node.register", { name: `s1-member-a-${ts}`, capabilities: ["ui"] });
    const memberBReg = await memberB.request("node.register", { name: `s1-member-b-${ts}`, capabilities: ["ui"] });

    // admin creates channel
    const ch = await admin.request("channel.create", { cwd: ROOT, name: `s1-ch-${ts}` });
    assert(!!ch.channelId, "S1: channel.create returns channelId");
    assertEq(ch.name, `s1-ch-${ts}`, "S1: channel.create returns name");
    assert(!!ch.cwd || ch.cwd === ROOT, "S1: channel.create returns cwd");

    // admin joins
    await admin.request("channel.join", { channelId: ch.channelId });

    // member-a joins
    memberA.clearNotifications();
    await memberA.request("channel.join", { channelId: ch.channelId });

    // member-b joins — member-a should receive notification
    memberA.clearNotifications();
    await memberB.request("channel.join", { channelId: ch.channelId });
    await sleep(500);

    // Check event log
    const events = readEvents();

    // channel.created event
    const createdEvent = findEvent(events, "channel.created", e => e.channelId === ch.channelId);
    assert(!!createdEvent, "S1: channel.created event logged");

    // channel.nodeJoined events (x2 for member-a and member-b; admin also joins so x3 total, check at least 2 members)
    const joinedEvents = events.filter(e =>
      e.event === "channel.nodeJoined" && e.channelId === ch.channelId
    );
    assert(joinedEvents.length >= 2, "S1: channel.nodeJoined events logged (>=2)",
      `got ${joinedEvents.length}`);

    // channel.list shows members
    const chList = await admin.request("channel.list");
    const targetCh = chList.channels.find((c: any) => c.id === ch.channelId);
    const memberNames = targetCh ? Object.keys(targetCh.nodes) : [];
    assert(memberNames.includes(`s1-member-a-${ts}`), "S1: channel.list includes member-a");
    assert(memberNames.includes(`s1-member-b-${ts}`), "S1: channel.list includes member-b");

    // member-a receives channel.nodeJoined notification when member-b joins
    const joinNotifs = memberA.getNotifications("channel.nodeJoined");
    assert(joinNotifs.length >= 1, "S1: member-a receives channel.nodeJoined notification when member-b joins",
      `got ${joinNotifs.length} notifications`);

    // event order: channel.created before channel.nodeJoined
    const createdIdx = events.findIndex(e => e.event === "channel.created" && e.channelId === ch.channelId);
    const firstJoinedIdx = events.findIndex(e => e.event === "channel.nodeJoined" && e.channelId === ch.channelId);
    assert(
      createdIdx >= 0 && firstJoinedIdx >= 0 && createdIdx < firstJoinedIdx,
      "S1: event order — channel.created before channel.nodeJoined",
      `created@${createdIdx}, firstJoined@${firstJoinedIdx}`
    );
  } finally {
    await admin.disconnect().catch(() => {});
    await memberA.disconnect().catch(() => {});
    await memberB.disconnect().catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────
// S6: Stop node — channel cleanup
// ──────────────────────────────────────────────────────────────────────

async function testS6_StopNodeChannelCleanup() {
  console.log("\n▸ S6: Stop node — channel cleanup");

  const ts = Date.now();
  const admin = new WsClient();

  try {
    await admin.connect();
    const adminReg = await admin.request("node.register", { name: `s6-admin-${ts}`, capabilities: ["ui"] });

    // Spawn mock ACP node
    const spawnResult = await admin.request("node.spawn", {
      adapter: "mock",
      name: `s6-mock-${ts}`,
      cwd: ROOT,
    });
    assert(!!spawnResult.nodeId, "S6: mock node spawned");

    await waitForNodeStatus(admin, spawnResult.nodeId, "idle");

    // Create channel, add both
    const ch = await admin.request("channel.create", { cwd: ROOT, name: `s6-ch-${ts}` });
    await admin.request("channel.join", { channelId: ch.channelId });
    await admin.request("channel.addNode", {
      channelId: ch.channelId,
      nodeId: spawnResult.nodeId,
      name: `s6-mock-${ts}`,
    });
    await sleep(300);

    // Clear notifications before stop
    admin.clearNotifications();

    // Stop mock node
    const stopResult = await admin.request("node.stop", { nodeId: spawnResult.nodeId });
    assert(stopResult?.ok === true, "S6: node.stop returns ok");

    await sleep(1000);

    const events = readEvents();

    // channel.nodeLeft event — NOTE: may FAIL if channel-manager doesn't handle node.stopped cleanup
    const leftEvent = findEvent(events, "channel.nodeLeft", e =>
      e.channelId === ch.channelId && e.nodeId === spawnResult.nodeId
    );
    assert(!!leftEvent, "S6: channel.nodeLeft event logged for stopped node (potential bug: channel-manager may not emit this)");

    // node.stopped event
    const stoppedEvent = findEvent(events, "node.stopped", e => e.nodeId === spawnResult.nodeId);
    assert(!!stoppedEvent, "S6: node.stopped event logged");

    // admin receives node.stopped WS notification
    const stoppedNotifs = admin.getNotifications("node.stopped");
    assert(stoppedNotifs.length >= 1, "S6: admin receives node.stopped WS notification",
      `got ${stoppedNotifs.length} notifications`);

    // channel.list no longer includes stopped node
    const chList = await admin.request("channel.list");
    const targetCh = chList.channels.find((c: any) => c.id === ch.channelId);
    const memberNames = targetCh ? Object.keys(targetCh.nodes) : [];
    assert(!memberNames.includes(`s6-mock-${ts}`), "S6: channel.list no longer includes stopped node");
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────
// S7: WS disconnect cleanup
// ──────────────────────────────────────────────────────────────────────

async function testS7_WsDisconnectCleanup() {
  console.log("\n▸ S7: WS disconnect cleanup");

  const ts = Date.now();
  const observer = new WsClient();
  const disconnecter = new WsClient();

  try {
    await observer.connect();
    await disconnecter.connect();

    const observerReg = await observer.request("node.register", { name: `s7-observer-${ts}`, capabilities: ["ui"] });
    const disconnecterReg = await disconnecter.request("node.register", { name: `s7-disc-${ts}`, capabilities: ["ui"] });

    // Create channel, both join
    const ch = await observer.request("channel.create", { cwd: ROOT, name: `s7-ch-${ts}` });
    await observer.request("channel.join", { channelId: ch.channelId });
    await disconnecter.request("channel.join", { channelId: ch.channelId });
    await sleep(300);

    // Clear observer notifications
    observer.clearNotifications();

    // Disconnecter closes WS
    await disconnecter.disconnect();
    await sleep(1000);

    const events = readEvents();

    // channel.nodeLeft event for disconnecter
    const leftEvent = findEvent(events, "channel.nodeLeft", e =>
      e.channelId === ch.channelId && e.nodeId === disconnecterReg.nodeId
    );
    assert(!!leftEvent, "S7: channel.nodeLeft event logged for disconnecter");

    // node.stopped event for disconnecter (WS nodes removed via nodePool.remove -> _cleanupNode)
    const stoppedEvent = findEvent(events, "node.stopped", e => e.nodeId === disconnecterReg.nodeId);
    assert(!!stoppedEvent, "S7: node.stopped event logged for disconnecter");

    // observer receives channel.nodeLeft notification
    const leftNotifs = observer.getNotifications("channel.nodeLeft");
    assert(leftNotifs.length >= 1, "S7: observer receives channel.nodeLeft notification",
      `got ${leftNotifs.length} notifications`);

    // observer receives node.stopped notification
    const stoppedNotifs = observer.getNotifications("node.stopped");
    assert(stoppedNotifs.length >= 1, "S7: observer receives node.stopped notification",
      `got ${stoppedNotifs.length} notifications`);

    // node.list no longer includes disconnecter
    const nodeList = await observer.request("node.list");
    const nodeIds = nodeList.nodes.map((n: any) => n.id);
    assert(!nodeIds.includes(disconnecterReg.nodeId), "S7: node.list no longer includes disconnecter");
  } finally {
    await observer.disconnect().catch(() => {});
    await disconnecter.disconnect().catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════");
  console.log("  Harness Phase3 Channel Tests (Red)");
  console.log("════════════════════════════════════════════");

  try {
    await startServer();

    await testS1_ChannelCreateAndAddNodes();
    await testS6_StopNodeChannelCleanup();
    await testS7_WsDisconnectCleanup();
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
