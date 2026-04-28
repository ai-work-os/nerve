#!/usr/bin/env npx tsx
/**
 * DM Capture — Integration Tests (TDD Red Phase)
 *
 * Tests DM message capture end-to-end with a real server:
 * - observer node receives dm.prompt / dm.response events
 * - dm.response.text contains accumulated AI reply (via agent_message_chunk)
 * - non-observer node does NOT receive dm.* events
 * - error path: dm.response carries error
 * - buffer cleanup after prompt completes
 *
 * Uses `mock` adapter (test/mock-agent.ts) which sends agent_message_chunk
 * on session/prompt, giving us real ACP interaction to test text accumulation.
 *
 * Run: npx tsx test/dm-capture.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14810;
const TEST_DATA = resolve(ROOT, ".test-data-dm-capture");

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
// WebSocket client helper
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

  async waitForNotification(method: string, timeoutMs = 5000): Promise<{ method: string; params: any }> {
    const existing = this.notifications.find(n => n.method === method);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const found = this.notifications.find(n => n.method === method);
        if (found) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(found);
        }
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
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

// ============================================================
// Server lifecycle
// ============================================================

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

// ============================================================
// Helpers — spawn mock AI via adapter, register observer/regular
// ============================================================

/** Spawn a mock AI node using the "mock" adapter (test/mock-agent.ts).
 *  This is a real stdio process node that speaks ACP and sends
 *  agent_message_chunk on prompt. */
async function spawnMockAi(caller: WsClient, name: string): Promise<{ nodeId: string }> {
  const result = await caller.request("node.spawn", {
    adapter: "mock",
    name,
    cwd: ROOT,
  });
  // Wait for ACP handshake to complete (mock-agent is fast)
  await sleep(2000);
  return result;
}

async function registerObserver(name: string): Promise<WsClient> {
  const obs = new WsClient();
  await obs.connect();
  await obs.request("node.register", {
    name,
    capabilities: ["monitor"],
    permissions: "observer",
  });
  return obs;
}

async function registerRegularNode(name: string): Promise<WsClient> {
  const client = new WsClient();
  await client.connect();
  await client.request("node.register", {
    name,
    capabilities: ["ui"],
  });
  return client;
}

async function stopMockAi(caller: WsClient, nodeId: string): Promise<void> {
  try {
    await caller.request("node.stop", { nodeId });
  } catch {
    // Ignore — node may already be stopped
  }
  await sleep(500);
}

// ============================================================
// Integration tests
// ============================================================

async function testObserverReceivesDmPrompt() {
  console.log("\n▸ DM capture: observer receives dm.prompt on node.prompt");

  const observer = await registerObserver("obs-dm-1");
  const sender = await registerRegularNode("sender-1");

  // Spawn a real mock AI node (stdio process, speaks ACP)
  const ai = await spawnMockAi(sender, "mock-ai-1");
  assert(!!ai.nodeId, "mock AI spawned");

  observer.clearNotifications();

  // Prompt the AI — mock-agent will process and reply
  const promptPromise = sender.request("node.prompt", {
    nodeId: ai.nodeId,
    content: "Hello AI, what's the weather?",
  });

  try {
    // Wait for observer to receive dm.prompt
    const dmPrompt = await observer.waitForNotification("dm.prompt", 5000);
    assert(!!dmPrompt, "observer received dm.prompt");
    assertEq(dmPrompt.params.text, "Hello AI, what's the weather?", "dm.prompt has correct text");
    assertEq(dmPrompt.params.targetNodeId, ai.nodeId, "dm.prompt has targetNodeId");
    assertEq(dmPrompt.params.targetNodeName, "mock-ai-1", "dm.prompt has targetNodeName");
    assert(!!dmPrompt.params.ts, "dm.prompt has timestamp");
    assertEq(dmPrompt.params.from?.name, "sender-1", "dm.prompt.from has sender name");
  } catch (err: any) {
    const dmPrompts = observer.getNotifications("dm.prompt");
    assert(dmPrompts.length > 0, `observer received dm.prompt (${err.message})`);
  }

  promptPromise.catch(() => {});
  await sleep(500);
  await stopMockAi(sender, ai.nodeId);
  await observer.disconnect();
  await sender.disconnect();
}

async function testObserverReceivesDmResponseWithText() {
  console.log("\n▸ DM capture: observer receives dm.response with accumulated AI text");

  const observer = await registerObserver("obs-dm-2");
  const sender = await registerRegularNode("sender-2");
  const ai = await spawnMockAi(sender, "mock-ai-2");

  observer.clearNotifications();

  // Prompt the AI — mock-agent sends agent_message_chunk with text
  // containing '[mock processing: "Tell me a joke"]', then responds with end_turn
  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "Tell me a joke",
    });
  } catch {
    // May timeout, but dm events should still fire
  }

  await sleep(1000);

  // Check dm.response
  const dmResponses = observer.getNotifications("dm.response");
  assert(dmResponses.length > 0, "observer received dm.response");

  if (dmResponses.length > 0) {
    const resp = dmResponses[0].params;
    assertEq(resp.targetNodeId, ai.nodeId, "dm.response has targetNodeId");
    assertEq(resp.targetNodeName, "mock-ai-2", "dm.response has targetNodeName");
    assert(typeof resp.durationMs === "number", "dm.response has durationMs");
    assert(!!resp.ts, "dm.response has timestamp");

    // Key test: dm.response.text should contain accumulated chunk text
    // mock-agent sends: agent_message_chunk with '[mock processing: "Tell me a joke"]'
    assert(typeof resp.text === "string", "dm.response.text is string");
    assert(resp.text.length > 0, "dm.response.text is non-empty (chunks accumulated)");
    assert(resp.text.includes("mock processing"), "dm.response.text contains mock agent reply");
  }

  await stopMockAi(sender, ai.nodeId);
  await observer.disconnect();
  await sender.disconnect();
}

async function testNonObserverDoesNotReceiveDm() {
  console.log("\n▸ DM capture: non-observer node does NOT receive dm.* events");

  const observer = await registerObserver("obs-dm-3");
  const regular = await registerRegularNode("regular-3");
  const ai = await spawnMockAi(regular, "mock-ai-3");

  observer.clearNotifications();
  regular.clearNotifications();

  // Prompt the AI
  try {
    await regular.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "test prompt for permission check",
    });
  } catch {
    // Expected
  }

  await sleep(1500);

  // Observer should have dm.* events
  const obsDm = observer.getNotifications().filter(n => n.method.startsWith("dm."));
  assert(obsDm.length > 0, "observer received dm.* events");

  // Regular node should NOT have dm.* events
  const regDm = regular.getNotifications().filter(n => n.method.startsWith("dm."));
  assertEq(regDm.length, 0, "regular node received 0 dm.* events");

  await stopMockAi(regular, ai.nodeId);
  await observer.disconnect();
  await regular.disconnect();
}

async function testDmResponseOnPromptError() {
  console.log("\n▸ DM capture: dm.response carries error when prompt fails");

  const observer = await registerObserver("obs-dm-4");
  const sender = await registerRegularNode("sender-4");

  // Spawn mock AI and prompt with "fail" keyword — mock-agent returns error
  const ai = await spawnMockAi(sender, "mock-ai-4");

  observer.clearNotifications();

  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "fail this prompt please",
    });
  } catch {
    // Expected
  }

  await sleep(1000);

  // dm.prompt should have fired
  const dmPrompts = observer.getNotifications("dm.prompt");
  assert(dmPrompts.length > 0, "dm.prompt emitted for failed prompt");

  // dm.response should carry error
  const dmResponses = observer.getNotifications("dm.response");
  assert(dmResponses.length > 0, "dm.response emitted even when prompt fails");

  if (dmResponses.length > 0) {
    const resp = dmResponses[0].params;
    assert(
      resp.error !== undefined || resp.stopReason !== undefined,
      "dm.response has error or stopReason on failed prompt"
    );
    assert(typeof resp.durationMs === "number", "dm.response has durationMs on error");
  }

  await stopMockAi(sender, ai.nodeId);
  await observer.disconnect();
  await sender.disconnect();
}

async function testDmResponseBufferCleanup() {
  console.log("\n▸ DM capture: _dmResponseBuffer is cleaned up between prompts");

  const observer = await registerObserver("obs-dm-5");
  const sender = await registerRegularNode("sender-5");
  const ai = await spawnMockAi(sender, "mock-ai-5");

  // First prompt
  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "first unique message alpha",
    });
  } catch {
    // Expected
  }

  await sleep(500);

  // Second prompt
  observer.clearNotifications();

  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "second unique message beta",
    });
  } catch {
    // Expected
  }

  await sleep(1000);

  // The second dm.response text should NOT contain first prompt's reply
  const dmResponses = observer.getNotifications("dm.response");
  if (dmResponses.length > 0) {
    const lastResp = dmResponses[dmResponses.length - 1].params;
    assert(
      !lastResp.text?.includes("alpha"),
      "_dmResponseBuffer does not leak text from first prompt into second"
    );
  }

  await stopMockAi(sender, ai.nodeId);
  await observer.disconnect();
  await sender.disconnect();
}

async function testDmPromptResponsePairing() {
  console.log("\n▸ DM capture: every dm.prompt has a matching dm.response");

  const observer = await registerObserver("obs-dm-6");
  const sender = await registerRegularNode("sender-6");
  const ai = await spawnMockAi(sender, "mock-ai-6");

  observer.clearNotifications();

  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "pairing test",
    });
  } catch {
    // Expected
  }

  await sleep(1000);

  const prompts = observer.getNotifications("dm.prompt");
  const responses = observer.getNotifications("dm.response");

  assert(prompts.length > 0, "at least one dm.prompt received");
  assertEq(prompts.length, responses.length, "dm.prompt count === dm.response count (pairing)");

  if (prompts.length > 0 && responses.length > 0) {
    assertEq(
      prompts[0].params.targetNodeId,
      responses[0].params.targetNodeId,
      "prompt and response target same node"
    );
  }

  await stopMockAi(sender, ai.nodeId);
  await observer.disconnect();
  await sender.disconnect();
}

async function testDmMessagesPersistedToSqlite() {
  console.log("\n▸ DM capture: node.prompt persists assembled DM messages to SQLite");

  const sender = await registerRegularNode("sender-db");
  const ai = await spawnMockAi(sender, "mock-ai-db");

  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "persist this dm",
    });
  } catch {
    // Existing mock timing can race, but persistence should still happen.
  }

  await sleep(1000);

  const db = new Database(resolve(TEST_DATA, "nerve.db"), { readonly: true });
  const rows = db.prepare(
    "SELECT node_id as nodeId, role, sender, text FROM dm_messages WHERE node_id = ? ORDER BY ts ASC"
  ).all(ai.nodeId) as Array<{ nodeId: string; role: string; sender: string; text: string }>;
  db.close();

  assert(rows.length >= 2, "dm_messages has user and agent rows");
  assert(rows.some(r => r.role === "user" && r.text === "persist this dm"), "user DM text persisted");
  assert(rows.some(r => r.role === "agent" && r.text.includes("mock processing")), "agent DM text persisted");

  await stopMockAi(sender, ai.nodeId);
  await sender.disconnect();
}

async function testMultipleObserversReceiveDm() {
  console.log("\n▸ DM capture: multiple observers all receive dm.* events");

  const obs1 = await registerObserver("obs-multi-1");
  const obs2 = await registerObserver("obs-multi-2");
  const sender = await registerRegularNode("sender-multi");
  const ai = await spawnMockAi(sender, "mock-ai-multi");

  obs1.clearNotifications();
  obs2.clearNotifications();

  try {
    await sender.request("node.prompt", {
      nodeId: ai.nodeId,
      content: "multi observer test",
    });
  } catch {
    // Expected
  }

  await sleep(1500);

  const obs1Dm = obs1.getNotifications().filter(n => n.method.startsWith("dm."));
  const obs2Dm = obs2.getNotifications().filter(n => n.method.startsWith("dm."));

  assert(obs1Dm.length > 0, "observer 1 received dm.* events");
  assert(obs2Dm.length > 0, "observer 2 received dm.* events");
  assertEq(obs1Dm.length, obs2Dm.length, "both observers received same number of dm.* events");

  await stopMockAi(sender, ai.nodeId);
  await obs1.disconnect();
  await obs2.disconnect();
  await sender.disconnect();
}

// ============================================================
// Run all tests
// ============================================================

async function main() {
  console.log("=== DM Capture Integration Tests ===");
  console.log(`Server port: ${TEST_PORT}`);

  try {
    await startServer();
    console.log("Server started");

    await testObserverReceivesDmPrompt();
    await testObserverReceivesDmResponseWithText();
    await testNonObserverDoesNotReceiveDm();
    await testDmResponseOnPromptError();
    await testDmResponseBufferCleanup();
    await testDmPromptResponsePairing();
    await testDmMessagesPersistedToSqlite();
    await testMultipleObserversReceiveDm();
  } catch (err) {
    console.error("Test runner error:", err);
    failed++;
    failures.push(`runner: ${err}`);
  } finally {
    stopServer();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  stopServer();
  process.exit(1);
});
