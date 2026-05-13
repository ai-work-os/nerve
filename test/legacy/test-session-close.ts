#!/usr/bin/env npx tsx
/**
 * Session Close Tests
 *
 * Tests for T1: session/close graceful shutdown.
 * Verifies closeSession is called before cleanup for ACP nodes,
 * skipped for WS/program nodes, and handles timeouts.
 *
 * These tests verify behavior at the node-pool/acp-client level
 * by checking:
 * 1. ACP node stop → closeSession called (mock agent supports session.close)
 * 2. ACP node stop + agent doesn't support session.close → skip, direct cleanup
 * 3. closeSession timeout → force close, no blocking
 * 4. WS node disconnect → no closeSession path
 * 5. Program node stop → no closeSession path
 *
 * Usage: npx tsx test/test-session-close.ts
 *   or included via: npx tsx test/self-test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14810; // Different port from self-test (14800)
const TEST_DATA = resolve(ROOT, ".test-data-session-close");

// --- Test infrastructure ---

let passed = 0;
let failed = 0;
const failures: string[] = [];
const serverLogBuffer: string[] = [];

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

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- HTTP helper ---

function httpPost(path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: "localhost",
      port: TEST_PORT,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- WebSocket helper ---

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];
  name: string;

  constructor(name: string) {
    this.name = name;
  }

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
      }, 10000);
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

// --- Server process management ---

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  serverProc = spawn("npx", ["tsx", "src/cli.ts", "serve", "--port", String(TEST_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NERVE_DATA: TEST_DATA,
      NERVE_PORT: String(TEST_PORT),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProc.stdout?.on("data", (d: Buffer) => {
    const lines = d.toString().split("\n").filter(Boolean);
    serverLogBuffer.push(...lines);
  });
  serverProc.stderr?.on("data", (d: Buffer) => {
    const lines = d.toString().split("\n").filter(Boolean);
    serverLogBuffer.push(...lines);
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        http.get(`http://localhost:${TEST_PORT}/health`, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => resolve());
        }).on("error", reject);
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Server failed to start");
}

function stopServer(): void {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

// =============================================================================
// Test 1: ACP node stop → closeSession called (agent supports session.close)
// =============================================================================
async function testAcpStopCallsCloseSession() {
  console.log("\n▸ ACP node stop → closeSession called");

  // Spawn mock agent that advertises session.close capability
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock-session-close",
    name: "sc-agent-1",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId");

  // Wait for handshake
  await sleep(3000);

  // Verify node is ready
  const nodes = await httpPost("/node/list", {});
  const node = (nodes as any).nodes.find((n: any) => n.name === "sc-agent-1");
  assert(!!node, "agent appears in node list");
  assert(node?.status === "idle" || node?.status === "connecting", `agent status: ${node?.status}`);

  // Stop the node
  await httpPost("/node/stop", { nodeId: spawn.nodeId });
  await sleep(1000);

  // Check server logs for closeSession call
  const closeSessionLogs = serverLogBuffer.filter(l =>
    l.includes("closeSession") || l.includes("session/close")
  );
  assert(closeSessionLogs.length > 0, "server log mentions closeSession/session/close");

  // Verify node is stopped/removed
  const nodes2 = await httpPost("/node/list", {});
  const stopped = (nodes2 as any).nodes.find((n: any) => n.name === "sc-agent-1");
  assert(!stopped || stopped.status === "stopped", "agent stopped after closeSession");
}

// =============================================================================
// Test 2: ACP node stop + agent doesn't support session.close → skip
// =============================================================================
async function testAcpStopSkipsWithoutCapability() {
  console.log("\n▸ ACP node stop without session.close capability → skip");

  // Use standard mock agent (no session.close capability)
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock",
    name: "sc-agent-2",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId");

  await sleep(3000);

  const logCountBefore = serverLogBuffer.length;

  // Stop the node
  await httpPost("/node/stop", { nodeId: spawn.nodeId });
  await sleep(1000);

  // Check that closeSession was skipped (log should mention skip or no closeSession attempt)
  const newLogs = serverLogBuffer.slice(logCountBefore);
  const skipLog = newLogs.filter(l =>
    l.includes("skip") && l.includes("closeSession") ||
    l.includes("session.close not supported")
  );
  const closeAttempt = newLogs.filter(l =>
    l.includes("closeSession") && !l.includes("skip") && !l.includes("not supported")
  );

  // Either we see a skip log, or we don't see any closeSession attempt
  assert(
    skipLog.length > 0 || closeAttempt.length === 0,
    "closeSession skipped for agent without capability"
  );

  // Node should still be cleanly stopped
  const nodes = await httpPost("/node/list", {});
  const stopped = (nodes as any).nodes.find((n: any) => n.name === "sc-agent-2");
  assert(!stopped || stopped.status === "stopped", "agent stopped without closeSession");
}

// =============================================================================
// Test 3: closeSession timeout → force close
// =============================================================================
async function testCloseSessionTimeout() {
  console.log("\n▸ closeSession timeout → force close");

  // Spawn mock agent that supports session.close but hangs on it
  const spawn = await httpPost("/node/spawn", {
    adapter: "mock-session-close-hang",
    name: "sc-agent-3",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId");

  await sleep(3000);

  const startTime = Date.now();

  // Stop the node (should timeout closeSession and force close)
  await httpPost("/node/stop", { nodeId: spawn.nodeId });
  await sleep(1000);

  const elapsed = Date.now() - startTime;

  // Should complete within reasonable time (closeSession timeout + buffer)
  // The timeout should be ~5s, so total should be under 10s
  assert(elapsed < 15000, `stop completed within timeout (${elapsed}ms)`);

  // Check for timeout log
  const timeoutLogs = serverLogBuffer.filter(l =>
    l.includes("closeSession") && l.includes("timeout")
  );
  assert(timeoutLogs.length > 0, "server log mentions closeSession timeout");

  // Node should be stopped despite timeout
  const nodes = await httpPost("/node/list", {});
  const stopped = (nodes as any).nodes.find((n: any) => n.name === "sc-agent-3");
  assert(!stopped || stopped.status === "stopped", "agent force-stopped after timeout");
}

// =============================================================================
// Test 4: WS node disconnect → no closeSession path
// =============================================================================
async function testWsDisconnectNoCloseSession() {
  console.log("\n▸ WS node disconnect → no closeSession");

  const client = new WsClient("ws-node-1");
  await client.connect();
  await client.request("node.register", { name: "ws-node-1", capabilities: ["ui"] });

  const logCountBefore = serverLogBuffer.length;

  // Disconnect the WS client
  await client.disconnect();
  await sleep(500);

  // Should NOT see any closeSession attempt in logs for WS node
  const newLogs = serverLogBuffer.slice(logCountBefore);
  const closeSessionAttempt = newLogs.filter(l =>
    l.includes("closeSession") && l.includes("ws-node-1")
  );
  assert(closeSessionAttempt.length === 0, "no closeSession for WS node disconnect");
}

// =============================================================================
// Test 5: Program node stop → no closeSession path
// =============================================================================
async function testProgramNodeNoCloseSession() {
  console.log("\n▸ Program node stop → no closeSession");

  const spawn = await httpPost("/node/spawn", {
    adapter: "mock-program",
    name: "sc-prog-1",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "program node spawn returns nodeId");

  await sleep(2000);

  const logCountBefore = serverLogBuffer.length;

  // Stop the program node
  await httpPost("/node/stop", { nodeId: spawn.nodeId });
  await sleep(1000);

  // Should NOT see closeSession attempt for program node
  const newLogs = serverLogBuffer.slice(logCountBefore);
  const closeSessionAttempt = newLogs.filter(l =>
    l.includes("closeSession") && l.includes("sc-prog-1")
  );
  assert(closeSessionAttempt.length === 0, "no closeSession for program node stop");

  // Program node should be stopped via SIGTERM
  const nodes = await httpPost("/node/list", {});
  const stopped = (nodes as any).nodes.find((n: any) => n.name === "sc-prog-1");
  assert(!stopped || stopped.status === "stopped", "program node stopped via SIGTERM");
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("=== Session Close Tests ===\n");

  try {
    await startServer();
    console.log(`Server started on port ${TEST_PORT}`);

    await testAcpStopCallsCloseSession();
    await testAcpStopSkipsWithoutCapability();
    await testCloseSessionTimeout();
    await testWsDisconnectNoCloseSession();
    await testProgramNodeNoCloseSession();
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
    failures.push(`fatal: ${err}`);
  } finally {
    stopServer();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
