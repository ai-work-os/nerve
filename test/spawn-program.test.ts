#!/usr/bin/env npx tsx
/**
 * Spawn Program Node — Tests
 *
 * Tests the full lifecycle of program nodes:
 * 1. node.spawn with type="program" adapter → creates placeholder node (status=connecting)
 * 2. Program connects via WS, node.register → matches pending, binds transport
 * 3. Node transitions to idle
 * 4. node.stop → kills process, node removed
 * 5. Timeout handling when program fails to connect
 * 6. Name conflict handling
 *
 * Usage: npx tsx test/spawn-program.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14801;
const TEST_DATA = resolve(ROOT, ".test-data-program");

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

// --- WS Client ---

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

// --- Helper: wait for notification ---

async function waitForNotification(
  client: WsClient,
  method: string,
  predicate: (params: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = client.getNotifications(method).find(n => predicate(n.params));
    if (match) return match.params;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${method}`);
}

// ============================================================
// TESTS
// ============================================================

async function testSpawnProgramNode() {
  console.log("\n▸ spawn program node — basic lifecycle");

  const tui = new WsClient("tui");
  await tui.connect();
  const reg = await tui.request("node.register", { name: "tui", capabilities: ["ui"] });
  tui.nodeId = reg.nodeId;

  // Spawn a program node using mock-program adapter
  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "test-prog",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId");
  assertEq(spawn.name, "test-prog", "spawn returns correct name");

  // Node should be registered (we get node.registered notification)
  await waitForNotification(tui, "node.registered", p => p.name === "test-prog");
  assert(true, "node.registered notification received");

  // Wait for the program to connect back and register — node transitions to idle
  await waitForNotification(tui, "node.statusChanged", p => p.name === "test-prog" && p.status === "idle");
  assert(true, "program node transitioned to idle after WS connect");

  // Verify node is in node.list
  const list = await tui.request("node.list");
  const progNode = list.nodes.find((n: any) => n.name === "test-prog");
  assert(!!progNode, "program node appears in node.list");
  assertEq(progNode?.status, "idle", "program node status is idle");
  assertEq(progNode?.transport, "websocket", "program node transport is websocket");
  assertEq(progNode?.adapter, "mock-program", "program node adapter is mock-program");

  // Stop the node
  await tui.request("node.stop", { nodeId: spawn.nodeId });

  // Wait for node.stopped notification
  await waitForNotification(tui, "node.stopped", p => p.nodeId === spawn.nodeId);
  assert(true, "node.stopped notification received after stop");

  // Verify node removed from list
  await sleep(200);
  const list2 = await tui.request("node.list");
  const removed = !list2.nodes.find((n: any) => n.name === "test-prog");
  assert(removed, "program node removed from node.list after stop");

  await tui.disconnect();
}

async function testSpawnProgramTimeout() {
  console.log("\n▸ spawn program node — connection timeout");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-timeout", capabilities: ["ui"] });

  // Spawn a program node that will never connect (bad-program adapter)
  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program-timeout",
    name: "timeout-prog",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId for timeout test");

  // Wait for node to error out (timeout is 5s for test adapter)
  // The node should emit node.statusChanged with status="error"
  await waitForNotification(
    tui,
    "node.statusChanged",
    p => p.name === "timeout-prog" && p.status === "error",
    8000,
  );
  assert(true, "program node timed out with error status");

  // Eventually gets stopped notification (process killed)
  await waitForNotification(tui, "node.stopped", p => p.name === "timeout-prog", 5000);
  assert(true, "timed out program node process killed");

  await tui.disconnect();
}

async function testSpawnProgramNameConflict() {
  console.log("\n▸ spawn program node — name conflict");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-conflict", capabilities: ["ui"] });

  // Spawn first program node
  const spawn1 = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "conflict-prog",
    cwd: ROOT,
  });
  assert(!!spawn1.nodeId, "first spawn succeeds");

  // Try to spawn with same name — should fail
  try {
    await tui.request("node.spawn", {
      adapter: "mock-program",
      name: "conflict-prog",
      cwd: ROOT,
    });
    assert(false, "duplicate name should fail");
  } catch (err: any) {
    assert(err.message.includes("already taken"), "duplicate name rejected with correct error");
  }

  // Clean up
  await tui.request("node.stop", { nodeId: spawn1.nodeId });
  await sleep(500);
  await tui.disconnect();
}

async function testProgramNodeInChannel() {
  console.log("\n▸ spawn program node — works in channel");

  const tui = new WsClient("tui");
  await tui.connect();
  const reg = await tui.request("node.register", { name: "tui-ch", capabilities: ["ui"] });

  // Create channel
  const ch = await tui.request("channel.create", { cwd: ROOT, name: "test-ch" });

  // Join TUI to channel
  await tui.request("channel.join", { channelId: ch.channelId });

  // Spawn program node
  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "ch-prog",
    cwd: ROOT,
  });

  // Wait for it to connect
  await waitForNotification(tui, "node.statusChanged", p => p.name === "ch-prog" && p.status === "idle");

  // Add program node to channel
  await tui.request("channel.addNode", { channelId: ch.channelId, nodeId: spawn.nodeId, name: "ch-prog" });

  // Verify channel has both nodes
  const chList = await tui.request("channel.list");
  const channel = chList.channels.find((c: any) => c.id === ch.channelId);
  assert(!!channel, "channel exists");
  assert(!!channel?.nodes?.["ch-prog"], "program node in channel");
  assert(!!channel?.nodes?.["tui-ch"], "tui in channel");

  // Clean up
  await tui.request("node.stop", { nodeId: spawn.nodeId });
  await sleep(500);
  await tui.disconnect();
}

async function testPluginBaseEnvVars() {
  console.log("\n▸ plugin-base — environment variable priority");

  // This test verifies that PluginBase reads NERVE_PORT and NERVE_NODE_NAME from env.
  // We test by spawning mock-program which uses these env vars to connect.
  // The fact that testSpawnProgramNode passes already proves env vars work.
  // Here we just verify the mock-program connects with the correct name.

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-env", capabilities: ["ui"] });

  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "env-test-node",
    cwd: ROOT,
  });

  // Wait for connection — the mock-program reads NERVE_NODE_NAME env var
  await waitForNotification(tui, "node.statusChanged", p => p.name === "env-test-node" && p.status === "idle");

  // Verify node registered with correct name from env var
  const list = await tui.request("node.list");
  const node = list.nodes.find((n: any) => n.name === "env-test-node");
  assert(!!node, "node registered with name from NERVE_NODE_NAME env var");

  await tui.request("node.stop", { nodeId: spawn.nodeId });
  await sleep(500);
  await tui.disconnect();
}

async function testProgramNodeCrash() {
  console.log("\n▸ spawn program node — process crash (non-zero exit)");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-crash", capabilities: ["ui"] });

  // Spawn a program node that exits immediately with code 42
  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program-crash",
    name: "crash-prog",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "crash spawn returns nodeId");

  // Wait for node.stopped with exit code
  const stoppedParams = await waitForNotification(
    tui, "node.stopped", p => p.nodeId === spawn.nodeId, 5000,
  );
  assert(true, "crashed program node emits node.stopped");
  assertEq(stoppedParams.exitCode, 42, "exit code is 42");

  // Verify node removed from list
  await sleep(200);
  const list = await tui.request("node.list");
  const removed = !list.nodes.find((n: any) => n.name === "crash-prog");
  assert(removed, "crashed program node removed from node.list");

  await tui.disconnect();
}

async function testProgramNodeBadCmd() {
  console.log("\n▸ spawn program node — bad command (spawn error)");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-badcmd", capabilities: ["ui"] });

  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program-badcmd",
    name: "badcmd-prog",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "badcmd spawn returns nodeId");

  // Should get node.statusChanged with status=error (from proc.on("error"))
  await waitForNotification(
    tui, "node.statusChanged", p => p.name === "badcmd-prog" && p.status === "error", 5000,
  );
  assert(true, "bad command triggers error status");

  await sleep(500);
  await tui.disconnect();
}

async function testProgramNodeWsDisconnect() {
  console.log("\n▸ spawn program node — WS disconnect cleans up channels but keeps node");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-disc", capabilities: ["ui"] });

  // Create channel
  const ch = await tui.request("channel.create", { cwd: ROOT, name: "disc-ch" });
  await tui.request("channel.join", { channelId: ch.channelId });

  // Spawn and wait for connect
  const spawn = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "disc-prog",
    cwd: ROOT,
  });
  await waitForNotification(tui, "node.statusChanged", p => p.name === "disc-prog" && p.status === "idle");

  // Add to channel
  await tui.request("channel.addNode", { channelId: ch.channelId, nodeId: spawn.nodeId, name: "disc-prog" });

  // Verify in channel
  let chList = await tui.request("channel.list");
  let channel = chList.channels.find((c: any) => c.id === ch.channelId);
  assert(!!channel?.nodes?.["disc-prog"], "program node in channel before stop");

  // Stop the node (kills process, WS disconnects)
  await tui.request("node.stop", { nodeId: spawn.nodeId });
  await waitForNotification(tui, "node.stopped", p => p.nodeId === spawn.nodeId, 5000);

  // Verify removed from channel
  await sleep(200);
  chList = await tui.request("channel.list");
  channel = chList.channels.find((c: any) => c.id === ch.channelId);
  const progGone = !channel?.nodes?.["disc-prog"];
  assert(progGone, "program node removed from channel after stop");

  await tui.disconnect();
}

async function testSpawnGuardian() {
  console.log("\n▸ spawn guardian — full integration");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-guardian", capabilities: ["ui"] });

  // Spawn guardian via adapter (uses PluginBase, connects back via WS)
  const spawn = await tui.request("node.spawn", {
    adapter: "guardian",
    name: "guardian",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "guardian spawn returns nodeId");
  assertEq(spawn.name, "guardian", "guardian spawn returns correct name");

  // Wait for guardian to connect and become idle
  await waitForNotification(
    tui, "node.statusChanged",
    p => p.name === "guardian" && p.status === "idle",
    10000,
  );
  assert(true, "guardian transitioned to idle");

  // Verify guardian in node.list with correct properties
  const list = await tui.request("node.list");
  const gNode = list.nodes.find((n: any) => n.name === "guardian");
  assert(!!gNode, "guardian in node.list");
  assertEq(gNode?.transport, "websocket", "guardian transport is websocket");
  assertEq(gNode?.adapter, "guardian", "guardian adapter name correct");
  assert(gNode?.capabilities?.includes("monitor"), "guardian has monitor capability");

  // Wait a moment for guardian to start polling — verify activity updates
  await sleep(2000);
  const list2 = await tui.request("node.list");
  const gNode2 = list2.nodes.find((n: any) => n.name === "guardian");
  assert(!!gNode2?.activity, "guardian has activity set (polling)");

  // Stop guardian
  await tui.request("node.stop", { nodeId: spawn.nodeId });
  await waitForNotification(tui, "node.stopped", p => p.nodeId === spawn.nodeId, 5000);
  assert(true, "guardian stopped cleanly");

  await tui.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Spawn Program Node Tests           ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    console.log("\n⟳ Starting server...");
    await startServer();
    console.log("  Server started on port", TEST_PORT);

    await testSpawnProgramNode();
    await testSpawnProgramTimeout();
    await testSpawnProgramNameConflict();
    await testProgramNodeInChannel();
    await testPluginBaseEnvVars();
    await testProgramNodeCrash();
    await testProgramNodeBadCmd();
    await testProgramNodeWsDisconnect();
    await testSpawnGuardian();

  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    stopServer();
  }

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
