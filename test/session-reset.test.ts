#!/usr/bin/env npx tsx
/**
 * Session Reset Tests (TDD — Step 1)
 *
 * Tests for nerve_session_reset MCP tool + HTTP/WS endpoints.
 * Run: npx tsx test/session-reset.test.ts
 *
 * Requires nerve server with mock adapter support.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14801;
const TEST_DATA = resolve(ROOT, ".test-data-reset");

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
  nodeId?: string;
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

// --- Server process management ---

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
      if (s.includes("ERROR") || s.includes("error")) {
        process.stderr.write(`[server] ${s}`);
      }
    });
    serverProc!.stdout!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("started on port")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc!.on("error", (e) => { clearTimeout(timeout); reject(e); });
    serverProc!.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`server exited with code ${code}`));
      }
    });
  });
}

function stopServer(): void {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

// --- Helper: spawn mock agent and wait for ready ---

async function spawnMockAgent(ws: WsClient, name: string): Promise<{ nodeId: string; name: string }> {
  const result = await ws.request("node.spawn", { adapter: "mock", name, cwd: ROOT });
  // Wait for agent to complete ACP handshake
  await sleep(3000);
  return result;
}

// --- Helper: get node info by name ---

async function getNodeInfo(ws: WsClient, name: string): Promise<any> {
  const result = await ws.request("node.list");
  return result.nodes?.find((n: any) => n.name === name);
}

// ============================================================
// TESTS
// ============================================================

async function testResetParamValidation() {
  console.log("\n▸ session.reset: parameter validation");

  const c = new WsClient("reset-val");
  await c.connect();
  await c.request("node.register", { name: "reset-val", capabilities: ["ui"] });

  // Missing nodeName
  try {
    await c.request("session.reset", { summaryPath: "/tmp/s.md", expectedSessionId: "x" });
    assert(false, "missing nodeName should error");
  } catch (e: any) {
    assert(e.message.includes("nodeName"), "missing nodeName returns error", e.message);
  }

  // Missing summaryPath
  try {
    await c.request("session.reset", { nodeName: "nobody", expectedSessionId: "x" });
    assert(false, "missing summaryPath should error");
  } catch (e: any) {
    assert(e.message.includes("summaryPath"), "missing summaryPath returns error", e.message);
  }

  // Missing expectedSessionId
  try {
    await c.request("session.reset", { nodeName: "nobody", summaryPath: "/tmp/s.md" });
    assert(false, "missing expectedSessionId should error");
  } catch (e: any) {
    assert(e.message.includes("expectedSessionId"), "missing expectedSessionId returns error", e.message);
  }

  // Node not found
  try {
    await c.request("session.reset", { nodeName: "nonexistent", summaryPath: "/tmp/s.md", expectedSessionId: "x" });
    assert(false, "nonexistent node should error");
  } catch (e: any) {
    assert(e.message.includes("not found"), "nonexistent node returns not found", e.message);
  }

  await c.disconnect();
}

async function testResetParamValidationHttp() {
  console.log("\n▸ POST /session/reset: parameter validation");

  // Missing nodeName
  const r1 = await httpPost("/session/reset", { summaryPath: "/tmp/s.md", expectedSessionId: "x" });
  assert(!!r1.error, "HTTP missing nodeName returns error");

  // Missing summaryPath
  const r2 = await httpPost("/session/reset", { nodeName: "nobody", expectedSessionId: "x" });
  assert(!!r2.error, "HTTP missing summaryPath returns error");

  // Missing expectedSessionId
  const r3 = await httpPost("/session/reset", { nodeName: "nobody", summaryPath: "/tmp/s.md" });
  assert(!!r3.error, "HTTP missing expectedSessionId returns error");

  // Node not found
  const r4 = await httpPost("/session/reset", { nodeName: "nonexistent", summaryPath: "/tmp/s.md", expectedSessionId: "x" });
  assert(!!r4.error, "HTTP nonexistent node returns error");
}

async function testResetBasic() {
  console.log("\n▸ session.reset: basic flow");

  const c = new WsClient("reset-basic");
  await c.connect();
  await c.request("node.register", { name: "reset-basic", capabilities: ["ui"] });

  // Spawn mock agent
  const agent = await spawnMockAgent(c, "reset-agent-1");
  assert(!!agent.nodeId, "agent spawned");

  // Get initial session ID
  const info1 = await getNodeInfo(c, "reset-agent-1");
  assert(!!info1, "agent found in node list");
  assert(!!info1.sessionId, "agent has session ID");
  assertEq(info1.status, "idle", "agent is idle");
  const oldSessionId = info1.sessionId;

  // Reset session via WS
  const resetResult = await c.request("session.reset", {
    nodeName: "reset-agent-1",
    expectedSessionId: oldSessionId,
    summaryPath: "/tmp/test-summary.md",
  });
  assert(!!resetResult.sessionId, "reset returns new sessionId");
  assert(!!resetResult.previousSessionId, "reset returns previousSessionId");
  assertEq(resetResult.previousSessionId, oldSessionId, "previousSessionId matches old session");
  assert(resetResult.sessionId !== oldSessionId, "new sessionId differs from old");

  // Verify node state after reset
  await sleep(1000); // Wait for state update
  const info2 = await getNodeInfo(c, "reset-agent-1");
  assertEq(info2.sessionId, resetResult.sessionId, "node sessionId updated");
  assert(!info2.usage, "node usage cleared after reset");

  // Clean up
  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetSessionMismatch() {
  console.log("\n▸ session.reset: session mismatch rejection");

  const c = new WsClient("reset-mismatch");
  await c.connect();
  await c.request("node.register", { name: "reset-mismatch", capabilities: ["ui"] });

  const agent = await spawnMockAgent(c, "reset-agent-2");

  // Try reset with wrong expectedSessionId
  try {
    await c.request("session.reset", {
      nodeName: "reset-agent-2",
      expectedSessionId: "wrong-session-id",
      summaryPath: "/tmp/test-summary.md",
    });
    assert(false, "session mismatch should error");
  } catch (e: any) {
    assert(e.message.includes("mismatch"), "session mismatch returns error", e.message);
  }

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetBusyRejection() {
  console.log("\n▸ session.reset: busy agent rejection");

  const c = new WsClient("reset-busy");
  await c.connect();
  await c.request("node.register", { name: "reset-busy", capabilities: ["ui"] });

  const agent = await spawnMockAgent(c, "reset-agent-3");
  const info = await getNodeInfo(c, "reset-agent-3");

  // Send a slow prompt to make agent busy
  // Don't await — we need agent to stay busy
  const promptPromise = c.request("node.prompt", { nodeId: agent.nodeId, content: "slow task" });

  // Wait a bit for agent to become busy
  await sleep(500);

  // Try reset while busy
  try {
    await c.request("session.reset", {
      nodeName: "reset-agent-3",
      expectedSessionId: info.sessionId,
      summaryPath: "/tmp/test-summary.md",
    });
    assert(false, "busy agent reset should error");
  } catch (e: any) {
    assert(e.message.includes("busy"), "busy agent returns error", e.message);
  }

  // Cancel the slow prompt so we can clean up
  await c.request("node.cancel", { nodeId: agent.nodeId });
  await promptPromise.catch(() => {}); // Ignore cancel error
  await sleep(500);

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetMutex() {
  console.log("\n▸ session.reset: concurrent reset mutex");

  const c = new WsClient("reset-mutex");
  await c.connect();
  await c.request("node.register", { name: "reset-mutex", capabilities: ["ui"] });

  const agent = await spawnMockAgent(c, "reset-agent-4");
  const info = await getNodeInfo(c, "reset-agent-4");

  // Fire two concurrent resets
  const p1 = c.request("session.reset", {
    nodeName: "reset-agent-4",
    expectedSessionId: info.sessionId,
    summaryPath: "/tmp/summary1.md",
  });
  const p2 = c.request("session.reset", {
    nodeName: "reset-agent-4",
    expectedSessionId: info.sessionId,
    summaryPath: "/tmp/summary2.md",
  });

  const results = await Promise.allSettled([p1, p2]);
  const successes = results.filter(r => r.status === "fulfilled");
  const failures_r = results.filter(r => r.status === "rejected");

  // One should succeed, one should fail (either mismatch or in-progress)
  assert(successes.length === 1, "exactly one concurrent reset succeeds", `${successes.length} succeeded`);
  assert(failures_r.length === 1, "exactly one concurrent reset fails", `${failures_r.length} failed`);
  if (failures_r.length > 0) {
    const err = (failures_r[0] as PromiseRejectedResult).reason.message;
    assert(
      err.includes("in progress") || err.includes("mismatch"),
      "concurrent reset fails with in-progress or mismatch",
      err,
    );
  }

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetStateCleanup() {
  console.log("\n▸ session.reset: state cleanup (buffer, usage, prompted)");

  const c = new WsClient("reset-state");
  await c.connect();
  await c.request("node.register", { name: "reset-state", capabilities: ["ui"] });

  // Spawn and add to channel
  const agent = await spawnMockAgent(c, "reset-agent-5");
  const ch = await c.request("channel.create", { cwd: ROOT, name: "reset-state-ch" });
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: agent.nodeId, name: "reset-agent-5" });

  // Send a prompt to populate buffer and mark prompted=true
  await c.request("channel.post", { channelId: ch.channelId, content: "@reset-agent-5 hello" });
  await sleep(3000); // Wait for prompt processing

  // Verify agent has updates in buffer
  const updates1 = await c.request("node.updates", { nodeName: "reset-agent-5" });
  assert(updates1.updates?.length > 0, "agent has updates before reset");

  const info1 = await getNodeInfo(c, "reset-agent-5");

  // Reset
  const resetResult = await c.request("session.reset", {
    nodeName: "reset-agent-5",
    expectedSessionId: info1.sessionId,
    summaryPath: "/tmp/test-summary.md",
  });
  assert(!!resetResult.sessionId, "reset succeeded");

  // Wait for reset to complete and recovery prompt to be sent
  await sleep(3000);

  // Verify buffer was cleared (new updates are from recovery prompt only)
  const updates2 = await c.request("node.updates", { nodeName: "reset-agent-5" });
  // After reset, buffer should only have updates from the recovery prompt, not the old ones
  // The old "hello" prompt updates should be gone
  const oldUpdates = updates2.updates?.filter(
    (u: any) => u.update?.content?.text?.includes("hello")
  );
  assertEq(oldUpdates?.length || 0, 0, "old buffer entries cleared after reset");

  // Verify usage is cleared
  const info2 = await getNodeInfo(c, "reset-agent-5");
  assert(!info2.usage, "usage cleared after reset");

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetRecoveryPrompt() {
  console.log("\n▸ session.reset: agent receives recovery prompt");

  const c = new WsClient("reset-prompt");
  await c.connect();
  await c.request("node.register", { name: "reset-prompt", capabilities: ["ui"] });

  // Spawn and add to channel
  const agent = await spawnMockAgent(c, "reset-agent-6");
  const ch = await c.request("channel.create", { cwd: ROOT, name: "reset-prompt-ch" });
  await c.request("channel.addNode", { channelId: ch.channelId, nodeId: agent.nodeId, name: "reset-agent-6" });

  // Subscribe to agent updates
  await c.request("node.subscribe", { nodeId: agent.nodeId });
  c.clearNotifications();

  const info = await getNodeInfo(c, "reset-agent-6");

  // Reset
  const summaryPath = "/tmp/test-summary-recovery.md";
  await c.request("session.reset", {
    nodeName: "reset-agent-6",
    expectedSessionId: info.sessionId,
    summaryPath,
  });

  // Wait for recovery prompt to be processed
  await sleep(3000);

  // Check that agent received a prompt containing the summary path
  // The promptNode call pushes a user_message update with the full prompt text
  // node.update notifications are pushed to subscribers
  const updates = c.getNotifications("node.update");

  // Check all notification types for the summary path
  const hasRecoveryContent = updates.some(
    (n: any) => {
      const params = n.params || {};
      // node.update wraps the update in params directly
      const update = params.update || {};
      const text = update?.content?.text || "";
      return text.includes(summaryPath) || text.includes("总结文件");
    }
  );

  // Fallback: check the update buffer directly via node.updates
  let bufferHasRecovery = false;
  if (!hasRecoveryContent) {
    const bufResult = await c.request("node.updates", { nodeName: "reset-agent-6" });
    bufferHasRecovery = bufResult.updates?.some(
      (u: any) => {
        const text = u.update?.content?.text || "";
        return text.includes(summaryPath) || text.includes("总结文件");
      }
    ) || false;
  }

  assert(hasRecoveryContent || bufferHasRecovery, "agent received recovery prompt with summary path");

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testResetHttpEndpoint() {
  console.log("\n▸ POST /session/reset: basic flow");

  const c = new WsClient("reset-http");
  await c.connect();
  await c.request("node.register", { name: "reset-http", capabilities: ["ui"] });

  const agent = await spawnMockAgent(c, "reset-agent-7");
  const info = await getNodeInfo(c, "reset-agent-7");

  // Reset via HTTP
  const result = await httpPost("/session/reset", {
    nodeName: "reset-agent-7",
    expectedSessionId: info.sessionId,
    summaryPath: "/tmp/test-summary-http.md",
  });
  assert(!!result.sessionId, "HTTP reset returns new sessionId");
  assert(!!result.previousSessionId, "HTTP reset returns previousSessionId");
  assertEq(result.previousSessionId, info.sessionId, "HTTP previousSessionId matches");
  assert(result.sessionId !== info.sessionId, "HTTP new sessionId differs");

  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

async function testSelfResetWhileBusy() {
  console.log("\n▸ POST /session/reset: selfReset bypasses busy check");

  const c = new WsClient("reset-self");
  await c.connect();
  await c.request("node.register", { name: "reset-self", capabilities: ["ui"] });

  const agent = await spawnMockAgent(c, "reset-agent-8");
  const info = await getNodeInfo(c, "reset-agent-8");

  // Send a slow prompt to make agent busy
  const promptPromise = c.request("node.prompt", { nodeId: agent.nodeId, content: "slow task" });
  await sleep(500);

  // Verify agent is busy
  const info2 = await getNodeInfo(c, "reset-agent-8");
  assertEq(info2.status, "busy", "agent is busy before self-reset");

  // Self-reset via HTTP with selfReset=true should succeed
  const result = await httpPost("/session/reset", {
    nodeName: "reset-agent-8",
    expectedSessionId: info.sessionId,
    summaryPath: "/tmp/test-summary-self.md",
    selfReset: true,
  });
  assert(!!result.sessionId, "self-reset succeeds while busy");
  assert(!!result.previousSessionId, "self-reset returns previousSessionId");

  // Verify the busy check still works for external callers
  // Spawn a fresh agent and make it busy to test this cleanly
  const agent2 = await spawnMockAgent(c, "reset-agent-8b");
  const info3 = await getNodeInfo(c, "reset-agent-8b");
  const promptPromise2 = c.request("node.prompt", { nodeId: agent2.nodeId, content: "slow task" });
  await sleep(500);
  const result2 = await httpPost("/session/reset", {
    nodeName: "reset-agent-8b",
    expectedSessionId: info3.sessionId,
    summaryPath: "/tmp/test-summary-ext.md",
  });
  assert(!!result2.error, "external reset still blocked when busy");
  await c.request("node.cancel", { nodeId: agent2.nodeId });
  await promptPromise2.catch(() => {});
  await c.request("node.stop", { nodeId: agent2.nodeId });

  // Clean up
  await promptPromise.catch(() => {}); // Ignore errors from old prompt
  await sleep(500);
  await c.request("node.stop", { nodeId: agent.nodeId });
  await sleep(500);
  await c.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Session Reset Tests");
  console.log("═══════════════════════════════════════");

  try {
    console.log("\nStarting server...");
    await startServer();
    console.log("Server ready.\n");

    // Parameter validation
    await testResetParamValidation();
    await testResetParamValidationHttp();

    // Core functionality
    await testResetBasic();
    await testResetSessionMismatch();
    await testResetBusyRejection();
    await testResetMutex();

    // State cleanup
    await testResetStateCleanup();
    await testResetRecoveryPrompt();

    // HTTP endpoint
    await testResetHttpEndpoint();

    // Self-reset (agent resets itself while busy)
    await testSelfResetWhileBusy();

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
