#!/usr/bin/env npx tsx
/**
 * Harness phase3 prompt scenarios S4, S5 — @mention and direct prompt (red)
 *
 * Run: npx tsx test/harness-phase3-prompt.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14832;
const TEST_DATA = resolve(ROOT, ".test-data-harness-phase3-prompt");
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

  getNotifications(): Array<{ method: string; params: any }> {
    return [...this.notifications];
  }

  clearNotifications(): void {
    this.notifications.length = 0;
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
  name?: string;
  status?: string;
  adapter?: string | null;
  transport?: string;
  channelId?: string;
  content?: string;
  delivery?: string;
  targetNodeId?: string;
  targetNodeName?: string;
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

async function waitForNodeStatus(client: WsClient, nodeId: string, status: string, timeoutMs = 15000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await client.request("node.list");
    const node = list.nodes.find((n: any) => n.id === nodeId);
    if (node?.status === status) return node;
    await sleep(100);
  }
  throw new Error(`timeout waiting for node ${nodeId} -> ${status}`);
}

function eventNamesForNode(nodeId: string): string[] {
  return readEvents().filter(e => e.nodeId === nodeId || e.targetNodeId === nodeId).map(e => {
    if (e.event === "node.statusChanged") return `${e.event}:${e.status}`;
    return e.event;
  });
}

// ─── S4: @mention process node — triggers direct prompt ────────────────────

async function testS4MentionTriggersPrompt(human: WsClient) {
  console.log("\n▸ S4: @mention process node triggers direct prompt");

  const ts = Date.now();
  const mockName = `mock-agent-${ts}`;

  // Spawn mock ACP node and wait for idle
  const spawnResult = await human.request("node.spawn", {
    adapter: "mock",
    name: mockName,
    cwd: ROOT,
  });
  const mockNodeId = spawnResult.nodeId;
  await waitForNodeStatus(human, mockNodeId, "idle");

  // Create channel, add human + mock-agent
  const channel = await human.request("channel.create", { cwd: ROOT, name: `s4-test-${ts}` });
  const channelId = channel.channelId;
  await human.request("channel.join", { channelId });
  await human.request("channel.addNode", { channelId, nodeId: mockNodeId, nodeName: mockName });

  // Clear notifications before the action
  human.clearNotifications();

  // Post @mention
  const mentionContent = `@${mockName} summarize this`;
  await human.request("channel.post", { channelId, content: mentionContent });

  // Wait for mock-agent to process and return to idle
  await waitForNodeStatus(human, mockNodeId, "idle", 15000);
  // Extra settle time for events to flush
  await sleep(1000);

  // Read events
  const events = readEvents();
  const channelEvents = events.filter(e => e.channelId === channelId);
  const nodeEvents = events.filter(e => e.nodeId === mockNodeId || e.targetNodeId === mockNodeId);

  // T1: channel.message event logged
  const messageEvent = channelEvents.find(e => e.event === "channel.message" && (e.content as string)?.includes("summarize this"));
  assert(!!messageEvent, "S4.1 channel.message event logged for @mention post");

  // T2: channel.mention event logged with delivery="direct_prompt"
  const mentionEvent = channelEvents.find(e =>
    e.event === "channel.mention" &&
    e.delivery === "direct_prompt" &&
    e.targetNodeName === mockName
  );
  assert(!!mentionEvent, "S4.2 channel.mention event logged with delivery=direct_prompt");

  // T3: dm.prompt event logged
  const promptEvent = nodeEvents.find(e => e.event === "dm.prompt");
  assert(!!promptEvent, "S4.3 dm.prompt event logged for mock-agent");

  // T4: node.statusChanged(busy) event logged
  // Filter only events after spawn idle (prompt-related busy)
  const spawnIdleIdx = events.findIndex(e =>
    e.event === "node.statusChanged" && (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId) && e.status === "idle"
  );
  const postSpawnEvents = events.slice(spawnIdleIdx + 1);
  const busyEvent = postSpawnEvents.find(e =>
    e.event === "node.statusChanged" &&
    (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId) &&
    e.status === "busy"
  );
  assert(!!busyEvent, "S4.4 node.statusChanged(busy) event logged for mock-agent");

  // T5: node.update event(s) logged (at least one)
  const updateEvents = postSpawnEvents.filter(e =>
    e.event === "node.update" &&
    (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId)
  );
  assert(updateEvents.length >= 1, "S4.5 at least one node.update event logged",
    `got ${updateEvents.length}`);

  // T6: dm.response event logged
  const responseEvent = postSpawnEvents.find(e =>
    e.event === "dm.response" &&
    (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId)
  );
  assert(!!responseEvent, "S4.6 dm.response event logged for mock-agent");

  // T7: node.statusChanged(idle) after dm.response
  const responseIdx = postSpawnEvents.findIndex(e =>
    e.event === "dm.response" &&
    (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId)
  );
  const postResponseIdle = postSpawnEvents.slice(responseIdx + 1).find(e =>
    e.event === "node.statusChanged" &&
    (e.nodeId === mockNodeId || e.targetNodeId === mockNodeId) &&
    e.status === "idle"
  );
  assert(!!postResponseIdle, "S4.7 node.statusChanged(idle) logged after dm.response");

  // T8: Event sequence order: message → mention → busy → prompt → [updates] → response → idle
  // Note: server sets status to busy BEFORE logging dm.prompt
  const relevantPostSpawn = postSpawnEvents.filter(e =>
    e.channelId === channelId ||
    e.nodeId === mockNodeId ||
    e.targetNodeId === mockNodeId
  );
  const sequenceNames = relevantPostSpawn.map(e => {
    if (e.event === "node.statusChanged") return `${e.event}:${e.status}`;
    return e.event;
  });

  const msgIdx = sequenceNames.indexOf("channel.message");
  const mentIdx = sequenceNames.indexOf("channel.mention");
  const bsyIdx = sequenceNames.indexOf("node.statusChanged:busy");
  const prmIdx = sequenceNames.indexOf("dm.prompt");
  const rspIdx = sequenceNames.indexOf("dm.response");
  const idlIdx = sequenceNames.lastIndexOf("node.statusChanged:idle");

  const orderCorrect =
    msgIdx >= 0 && mentIdx >= 0 && bsyIdx >= 0 && prmIdx >= 0 && rspIdx >= 0 && idlIdx >= 0 &&
    msgIdx < mentIdx && mentIdx < bsyIdx && bsyIdx < prmIdx && prmIdx < rspIdx && rspIdx < idlIdx;
  assert(orderCorrect, "S4.8 event sequence: message → mention → busy → prompt → response → idle",
    `got ${sequenceNames.join(" → ")}`);

  // T9: human receives node.statusChanged notifications but NOT channel.mention
  const humanNotifs = human.getNotifications();
  const statusNotifs = humanNotifs.filter(n =>
    n.method === "node.statusChanged" &&
    n.params?.nodeId === mockNodeId
  );
  const mentionNotifs = humanNotifs.filter(n => n.method === "channel.mention");
  assert(statusNotifs.length > 0, "S4.9a human receives node.statusChanged notifications");
  assert(mentionNotifs.length === 0, "S4.9b human does NOT receive channel.mention notifications",
    `got ${mentionNotifs.length}`);

  // Cleanup
  await human.request("node.stop", { nodeId: mockNodeId });
  await sleep(500);

  return mockNodeId;
}

// ─── S5: DM prompt — direct prompt without channel ─────────────────────────

async function testS5DirectPrompt(caller: WsClient) {
  console.log("\n▸ S5: DM prompt — direct prompt without channel");

  const ts = Date.now();
  const mockName = `mock-dm-${ts}`;

  // Spawn fresh mock ACP node
  const spawnResult = await caller.request("node.spawn", {
    adapter: "mock",
    name: mockName,
    cwd: ROOT,
  });
  const mockNodeId = spawnResult.nodeId;
  await waitForNodeStatus(caller, mockNodeId, "idle");

  // Record event count before prompt
  const eventsBefore = readEvents().length;

  // Call node.prompt (blocks until complete)
  const promptResult = await caller.request("node.prompt", {
    nodeId: mockNodeId,
    content: "hello direct",
  });

  // Extra settle time
  await sleep(500);

  // T1: node.prompt returns successfully
  assert(promptResult !== undefined && promptResult !== null, "S5.1 node.prompt returns successfully (no error)");

  // Read events after prompt
  const allEvents = readEvents();
  const promptEvents = allEvents.slice(eventsBefore);
  const nodePromptEvents = promptEvents.filter(e =>
    e.nodeId === mockNodeId || e.targetNodeId === mockNodeId
  );

  // T2: dm.prompt event logged with text "hello direct"
  const dmPrompt = nodePromptEvents.find(e =>
    e.event === "dm.prompt" &&
    ((e.text as string)?.includes("hello direct") || (e.content as string)?.includes("hello direct"))
  );
  assert(!!dmPrompt, "S5.2 dm.prompt event logged with text 'hello direct'");

  // T3: node.statusChanged(busy)
  const busyEvent = nodePromptEvents.find(e =>
    e.event === "node.statusChanged" && e.status === "busy"
  );
  assert(!!busyEvent, "S5.3 node.statusChanged(busy) event logged");

  // T4: node.update event(s) logged (at least one)
  const updateEvents = nodePromptEvents.filter(e => e.event === "node.update");
  assert(updateEvents.length >= 1, "S5.4 at least one node.update event logged",
    `got ${updateEvents.length}`);

  // T5: dm.response event logged
  const dmResponse = nodePromptEvents.find(e => e.event === "dm.response");
  assert(!!dmResponse, "S5.5 dm.response event logged");

  // T6: node.statusChanged(idle) after dm.response
  const responseIdx = nodePromptEvents.findIndex(e => e.event === "dm.response");
  const postResponseIdle = responseIdx >= 0
    ? nodePromptEvents.slice(responseIdx + 1).find(e =>
        e.event === "node.statusChanged" && e.status === "idle"
      )
    : undefined;
  assert(!!postResponseIdle, "S5.6 node.statusChanged(idle) logged after dm.response");

  // T7: Event sequence: busy → prompt → [update(s)] → response → idle
  // Note: server sets status to busy BEFORE logging dm.prompt
  const sequenceNames = nodePromptEvents.map(e => {
    if (e.event === "node.statusChanged") return `${e.event}:${e.status}`;
    return e.event;
  });

  const bsyIdx = sequenceNames.indexOf("node.statusChanged:busy");
  const prmIdx = sequenceNames.indexOf("dm.prompt");
  const rspIdx = sequenceNames.indexOf("dm.response");
  const idlIdx = sequenceNames.lastIndexOf("node.statusChanged:idle");

  const orderCorrect =
    bsyIdx >= 0 && prmIdx >= 0 && rspIdx >= 0 && idlIdx >= 0 &&
    bsyIdx < prmIdx && prmIdx < rspIdx && rspIdx < idlIdx;
  assert(orderCorrect, "S5.7 event sequence: busy → prompt → [update(s)] → response → idle",
    `got ${sequenceNames.join(" → ")}`);

  // Cleanup
  await caller.request("node.stop", { nodeId: mockNodeId });
  await sleep(500);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════");
  console.log("  Harness Phase3 Prompt Tests (Red)");
  console.log("════════════════════════════════════════════");

  const human = new WsClient();

  try {
    await startServer();
    await human.connect();
    await human.request("node.register", { name: "harness-human", capabilities: ["ui"] });

    await testS4MentionTriggersPrompt(human);
    await testS5DirectPrompt(human);
  } catch (err: any) {
    failed++;
    failures.push(`test harness crashed: ${err.message}`);
    console.log(`  ✗ test harness crashed — ${err.message}`);
  } finally {
    try { await human.disconnect(); } catch {}
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
