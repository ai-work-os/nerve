#!/usr/bin/env npx tsx
/**
 * Harness phase3 — channel message persist + broadcast & @mention (red)
 *
 * Run: npx tsx test/harness-phase3-messaging.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14831;
const TEST_DATA = resolve(ROOT, ".test-data-harness-phase3-messaging");
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
  from?: string;
  content?: string;
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

// ─── S2: Channel message persist + broadcast ───────────────────────────

async function testS2(poster: WsClient, listener: WsClient, posterNodeId: string, listenerNodeId: string) {
  console.log("\n▸ S2: Channel message persist + broadcast");

  const ts = Date.now();
  const channelName = `s2-chan-${ts}`;

  // Create channel and add both nodes
  const ch = await poster.request("channel.create", { name: channelName });
  const channelId = ch.channelId;
  assert(!!channelId, "channel created");

  // poster joins, then add listener
  await poster.request("channel.join", { channelId });
  await listener.request("channel.join", { channelId });

  // Clear notifications before tests
  poster.clearNotifications();
  listener.clearNotifications();

  // ── Test 1: channel.post returns message with id, from, content, ts ──
  const postResult = await poster.request("channel.post", { channelId, content: "hello world" });
  const msg = postResult.message;
  assert(!!msg, "S2.1 channel.post returns message object");
  assert(!!msg.id, "S2.1 channel.post returns message id");
  assert(!!msg.from, "S2.1 channel.post returns from");
  assertEq(msg.content, "hello world", "S2.1 channel.post returns content");
  assert(!!msg.timestamp, "S2.1 channel.post returns timestamp");

  // Wait for notifications to propagate
  await sleep(500);

  // ── Test 2: channel.message event logged ──
  const events = readEvents().filter(e => e.event === "channel.message" && e.channelId === channelId);
  assert(events.length >= 1, "S2.2 channel.message event logged");
  if (events.length > 0) {
    assertEq(events[0].content, "hello world", "S2.2 event content matches");
    assert(!!events[0].from, "S2.2 event has from field");
    assertEq(events[0].channelId, channelId, "S2.2 event channelId matches");
  }

  // ── Test 3: channel.history returns the posted message ──
  const history = await poster.request("channel.history", { channelId });
  const messages = history.messages || history;
  assert(Array.isArray(messages), "S2.3 channel.history returns array");
  const found = Array.isArray(messages) && messages.some((m: any) => m.content === "hello world");
  assert(found, "S2.3 channel.history contains posted message");

  // ── Test 4: listener receives channel.message WS notification ──
  const listenerMsgs = listener.getNotifications("channel.message");
  const listenerGot = listenerMsgs.some(n => n.params?.channelId === channelId && n.params?.message?.content === "hello world");
  assert(listenerGot, "S2.4 listener receives channel.message notification");

  // ── Test 5: poster receives channel.message WS notification (self-echo) ──
  const posterMsgs = poster.getNotifications("channel.message");
  const posterGot = posterMsgs.some(n => n.params?.channelId === channelId && n.params?.message?.content === "hello world");
  assert(posterGot, "S2.5 poster receives channel.message notification (self-echo)");

  // ── Test 6: Multiple posts — history returns messages in order ──
  await poster.request("channel.post", { channelId, content: "msg-A" });
  await poster.request("channel.post", { channelId, content: "msg-B" });
  await poster.request("channel.post", { channelId, content: "msg-C" });
  await sleep(300);

  const history2 = await poster.request("channel.history", { channelId });
  const msgs2 = history2.messages || history2;
  assert(Array.isArray(msgs2), "S2.6 history returns array after multiple posts");
  if (Array.isArray(msgs2)) {
    const contents = msgs2.map((m: any) => m.content);
    const idxA = contents.indexOf("msg-A");
    const idxB = contents.indexOf("msg-B");
    const idxC = contents.indexOf("msg-C");
    assert(
      idxA >= 0 && idxB >= 0 && idxC >= 0 && idxA < idxB && idxB < idxC,
      "S2.6 multiple posts history returns messages in order",
      `got ${JSON.stringify(contents)}`
    );
  }

  // ── Test 7: Message ids are unique ──
  if (Array.isArray(msgs2) && msgs2.length >= 2) {
    const ids = msgs2.map((m: any) => m.id).filter(Boolean);
    const uniqueIds = new Set(ids);
    assert(uniqueIds.size === ids.length, "S2.7 message ids are unique",
      `${ids.length} messages but only ${uniqueIds.size} unique ids`);
  } else {
    assert(false, "S2.7 message ids are unique", "not enough messages to verify");
  }
}

// ─── S3: @mention WS node — targeted notification ──────────────────────

async function testS3(mentioner: WsClient, targetWs: WsClient, bystander: WsClient, targetName: string) {
  console.log("\n▸ S3: @mention WS node — targeted notification");

  const ts = Date.now();
  const channelName = `s3-chan-${ts}`;

  // Create channel and add all three
  const ch = await mentioner.request("channel.create", { name: channelName });
  const channelId = ch.channelId;
  assert(!!channelId, "S3 channel created");

  await mentioner.request("channel.join", { channelId });
  await targetWs.request("channel.join", { channelId });
  await bystander.request("channel.join", { channelId });

  // Clear notifications
  mentioner.clearNotifications();
  targetWs.clearNotifications();
  bystander.clearNotifications();

  // Post with @mention
  const mentionContent = `@${targetName} please check this`;
  await mentioner.request("channel.post", { channelId, content: mentionContent });

  // Wait for notifications
  await sleep(500);

  // ── Test 1: channel.message event logged ──
  const msgEvents = readEvents().filter(e => e.event === "channel.message" && e.channelId === channelId);
  assert(msgEvents.length >= 1, "S3.1 channel.message event logged for @mention post");

  // ── Test 2: channel.mention event logged ──
  const mentionEvents = readEvents().filter(e => e.event === "channel.mention" && e.channelId === channelId);
  assert(mentionEvents.length >= 1, "S3.2 channel.mention event logged");
  if (mentionEvents.length > 0) {
    assertEq(mentionEvents[0].delivery, "ws_notification", "S3.2 mention delivery is ws_notification");
    assert(
      mentionEvents[0].targetNodeName === targetName || mentionEvents[0].target === targetName,
      "S3.2 mention targetNodeName matches",
      `got ${JSON.stringify(mentionEvents[0])}`
    );
  }

  // ── Test 3: target-ws receives channel.mention notification ──
  const targetMentions = targetWs.getNotifications("channel.mention");
  const targetGot = targetMentions.some(n => n.params?.channelId === channelId);
  assert(targetGot, "S3.3 target-ws receives channel.mention notification");

  // ── Test 4: bystander does NOT receive channel.mention ──
  const bystanderMentions = bystander.getNotifications("channel.mention");
  const bystanderGot = bystanderMentions.some(n => n.params?.channelId === channelId);
  assert(!bystanderGot, "S3.4 bystander does NOT receive channel.mention");

  // ── Test 5: mentioner does NOT receive channel.mention ──
  const mentionerMentions = mentioner.getNotifications("channel.mention");
  const mentionerGot = mentionerMentions.some(n => n.params?.channelId === channelId);
  assert(!mentionerGot, "S3.5 mentioner does NOT receive channel.mention");

  // ── Test 6: All three receive channel.message broadcast ──
  const mentionerMsgs = mentioner.getNotifications("channel.message").filter(n => n.params?.channelId === channelId);
  const targetMsgs = targetWs.getNotifications("channel.message").filter(n => n.params?.channelId === channelId);
  const bystanderMsgs = bystander.getNotifications("channel.message").filter(n => n.params?.channelId === channelId);
  assert(mentionerMsgs.length >= 1, "S3.6 mentioner receives channel.message broadcast");
  assert(targetMsgs.length >= 1, "S3.6 target-ws receives channel.message broadcast");
  assert(bystanderMsgs.length >= 1, "S3.6 bystander receives channel.message broadcast");
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════");
  console.log("  Harness Phase3 Messaging Tests (Red)");
  console.log("════════════════════════════════════════════");

  const poster = new WsClient();
  const listener = new WsClient();
  const mentioner = new WsClient();
  const targetWs = new WsClient();
  const bystander = new WsClient();

  const ts = Date.now();
  const targetName = `target-ws-${ts}`;

  try {
    await startServer();

    // Connect and register all clients
    await poster.connect();
    await listener.connect();
    await mentioner.connect();
    await targetWs.connect();
    await bystander.connect();

    const posterReg = await poster.request("node.register", { name: `poster-${ts}`, capabilities: ["ui"] });
    const listenerReg = await listener.request("node.register", { name: `listener-${ts}`, capabilities: ["ui"] });
    const mentionerReg = await mentioner.request("node.register", { name: `mentioner-${ts}`, capabilities: ["ui"] });
    const targetReg = await targetWs.request("node.register", { name: targetName, capabilities: ["ui"] });
    const bystanderReg = await bystander.request("node.register", { name: `bystander-${ts}`, capabilities: ["ui"] });

    // S2 tests
    await testS2(poster, listener, posterReg.nodeId, listenerReg.nodeId);

    // S3 tests
    await testS3(mentioner, targetWs, bystander, targetName);

  } catch (err: any) {
    failed++;
    failures.push(`test harness crashed: ${err.message}`);
    console.log(`  ✗ test harness crashed — ${err.message}`);
  } finally {
    try { await poster.disconnect(); } catch {}
    try { await listener.disconnect(); } catch {}
    try { await mentioner.disconnect(); } catch {}
    try { await targetWs.disconnect(); } catch {}
    try { await bystander.disconnect(); } catch {}
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
