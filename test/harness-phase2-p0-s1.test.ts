#!/usr/bin/env npx tsx
/**
 * Harness phase2 P0-S1 — ACP agent spawn lifecycle (red)
 *
 * Run: npx tsx test/harness-phase2-p0-s1.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14822;
const TEST_DATA = resolve(ROOT, ".test-data-harness-phase2-s1");
const EVENT_LOG = resolve(TEST_DATA, "events.jsonl");
const STABLE_ADAPTER = "mock";

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

type EventEntry = {
  ts: string;
  event: string;
  nodeId?: string;
  name?: string;
  status?: string;
  adapter?: string | null;
  transport?: string;
  cwd?: string;
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
      const s = d.toString();
      serverOutput.push(s);
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

function eventNamesForNode(nodeId: string): string[] {
  return readEvents().filter(e => e.nodeId === nodeId).map(e => {
    if (e.event !== "node.statusChanged") return e.event;
    return `${e.event}:${e.status}`;
  });
}

async function testStableAdapterCanReachIdle(client: WsClient) {
  console.log(`\n▸ adapter stability: ${STABLE_ADAPTER} reaches idle`);

  const spawnResult = await client.request("node.spawn", {
    adapter: STABLE_ADAPTER,
    name: `p0-s1-stable-${Date.now()}`,
    cwd: ROOT,
  });

  assert(!!spawnResult.nodeId, "spawn returns nodeId");
  assert(!!spawnResult.name, "spawn returns name");

  const node = await waitForNodeStatus(client, spawnResult.nodeId, "idle");
  assertEq(node.id, spawnResult.nodeId, "node.list contains spawned node");
  assertEq(node.name, spawnResult.name, "node.list name matches spawn result");
  assertEq(node.transport, "stdio", "spawned ACP node transport is stdio");
  assertEq(node.status, "idle", "spawned ACP node reaches idle");
  assertEq(node.adapter, STABLE_ADAPTER, "spawned ACP node adapter matches");
  assertEq(node.cwd, ROOT, "spawned ACP node cwd matches");

  await client.request("node.stop", { nodeId: spawnResult.nodeId });
  await sleep(500);
}

async function testLifecycleEventSequence(client: WsClient) {
  console.log("\n▸ P0-S1 lifecycle events: registered -> connecting -> idle");

  const spawnResult = await client.request("node.spawn", {
    adapter: STABLE_ADAPTER,
    name: `p0-s1-events-${Date.now()}`,
    cwd: ROOT,
  });

  const node = await waitForNodeStatus(client, spawnResult.nodeId, "idle");
  const events = readEvents().filter(e => e.nodeId === spawnResult.nodeId);
  const sequence = eventNamesForNode(spawnResult.nodeId);

  assert(events.length > 0, "event log contains spawned node events",
    `server=${serverOutput.join("").slice(-500)}`);
  assert(sequence.includes("node.registered"), "event log has node.registered");
  assert(sequence.includes("node.statusChanged:connecting"), "event log has node.statusChanged(connecting)");
  assert(sequence.includes("node.statusChanged:idle"), "event log has node.statusChanged(idle)");

  const registeredIndex = sequence.indexOf("node.registered");
  const connectingIndex = sequence.indexOf("node.statusChanged:connecting");
  const idleIndex = sequence.indexOf("node.statusChanged:idle");
  assert(
    registeredIndex >= 0 && connectingIndex >= 0 && idleIndex >= 0 &&
      registeredIndex < connectingIndex && connectingIndex < idleIndex,
    "event order is registered -> connecting -> idle",
    `got ${sequence.join(" -> ")}`
  );

  const registered = events.find(e => e.event === "node.registered");
  const connecting = events.find(e => e.event === "node.statusChanged" && e.status === "connecting");
  const idle = events.find(e => e.event === "node.statusChanged" && e.status === "idle");
  assertEq(registered?.transport, "stdio", "node.registered transport is stdio");
  assertEq(registered?.adapter, STABLE_ADAPTER, "node.registered adapter is correct");
  assertEq(connecting?.adapter, STABLE_ADAPTER, "connecting event adapter is correct");
  assertEq(idle?.adapter, STABLE_ADAPTER, "idle event adapter is correct");
  assertEq(node.adapter, STABLE_ADAPTER, "spawned node still healthy after event assertions");

  await client.request("node.stop", { nodeId: spawnResult.nodeId });
  await sleep(500);
}

async function main() {
  console.log("════════════════════════════════════════════");
  console.log("  Harness Phase2 P0-S1 Tests (Red)");
  console.log("════════════════════════════════════════════");

  const client = new WsClient();

  try {
    await startServer();
    await client.connect();
    await client.request("node.register", { name: "harness-p0-s1", capabilities: ["ui"] });

    await testStableAdapterCanReachIdle(client);
    await testLifecycleEventSequence(client);

    await client.disconnect();
  } catch (err: any) {
    failed++;
    failures.push(`test harness crashed: ${err.message}`);
    console.log(`  ✗ test harness crashed — ${err.message}`);
  } finally {
    try { await client.disconnect(); } catch {}
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
