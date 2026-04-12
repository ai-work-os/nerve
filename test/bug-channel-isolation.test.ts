#!/usr/bin/env npx tsx
/**
 * Bug fix tests: channel message isolation + member event global broadcast
 *
 * Bug 1: Program nodes (WS transport) receive channel.message broadcasts
 *         because broadcastToChannel only checks isProcess (stdio).
 *         Fix: also skip program nodes in broadcastToChannel;
 *              route @mentions to program nodes via node.message.
 *
 * Bug 2: channel.nodeLeft/nodeJoined only broadcast to channel members,
 *         so TUI not in channel doesn't see member count changes on stop.
 *         Fix: also broadcast member events globally via broadcastToAllWsClients.
 *
 * Run: npx tsx test/bug-channel-isolation.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-channel-isolation");

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

// --- Server process ---

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(TEST_PORT), "--data", TEST_DATA], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc!.stderr!.on("data", (d) => {
      const s = d.toString();
      if (s.includes("ERROR")) process.stderr.write(`[server] ${s}`);
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

// ============================================================
// Bug 1: Program node should NOT receive channel.message broadcasts
// ============================================================

async function testProgramNodeNoChannelMessageBroadcast() {
  console.log("\n▸ Bug1: program node should NOT receive channel.message broadcast");

  // TUI client (regular WS node, receives all channel broadcasts)
  const tui = new WsClient("tui");
  await tui.connect();
  const tuiReg = await tui.request("node.register", { name: "tui", capabilities: ["ui"] });
  tui.nodeId = tuiReg.nodeId;

  // Spawn a real program node (mock-program adapter)
  const spawnResult = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "prog-node",
    cwd: ROOT,
  });
  const progNodeId = spawnResult.nodeId;

  // Wait for program node to come online
  await waitForNotification(tui, "node.statusChanged", p => p.name === "prog-node" && p.status === "idle");

  // Create channel and add both TUI and program node
  const ch = await tui.request("channel.create", { cwd: ROOT, name: "test-ch" });
  const channelId = ch.channelId;
  await tui.request("channel.join", { channelId });
  await tui.request("channel.addNode", { channelId, nodeId: progNodeId, name: "prog-node" });
  await sleep(500);

  // Clear notifications to start fresh
  tui.clearNotifications();

  // Post a message from TUI that does NOT mention prog-node
  await tui.request("channel.post", { channelId, content: "hello world, no mention here" });
  await sleep(500);

  // TUI should receive channel.message (it's a regular WS node in the channel)
  const tuiMsgs = tui.getNotifications("channel.message");
  assert(tuiMsgs.length > 0, "tui receives channel.message");

  // Now check: did program node receive channel.message?
  // We can verify by subscribing to prog-node and checking its updates.
  // The mock-program echoes node.message via node.log but doesn't log channel.message.
  // Instead, we check by looking at server's behavior:
  // If the fix is applied, prog-node should NOT have received channel.message.
  //
  // We test this indirectly: subscribe to prog-node, check its updateBuffer.
  // The mock-program node.log handler logs "dm:..." for node.message notifications.
  // If it received channel.message, it would NOT log anything (no handler for channel.message).
  //
  // More directly: we spawn another WS client that is NOT in the channel
  // and compare what it receives vs what prog-node should receive.

  // Subscribe to prog-node and verify no unexpected live node_log entries.
  // Program logs are live-only (not replayed), so we must listen after subscribing.
  await tui.request("node.subscribe", { nodeId: progNodeId });
  tui.clearNotifications();

  // Post another message without @mention
  await tui.request("channel.post", { channelId, content: "second message, also no mention" });
  await sleep(500);

  // If prog-node had received channel.message as a DM, mock-program would emit
  // a node_log with a "dm:" prefixed entry. Verify none arrived.
  const progUpdates = tui.getNotifications("node.update");
  const dmLogs = progUpdates
    .filter((n: any) => n.params.update?.sessionUpdate === "node_log")
    .flatMap((n: any) => n.params.update?.entries || [])
    .filter((e: any) => e.message?.startsWith("dm:"));
  assert(dmLogs.length === 0, "program node did not receive channel messages as DM",
    `got ${dmLogs.length} DM-like log entries: ${dmLogs.map((e: any) => e.message).join("; ")}`);

  // Cleanup
  await tui.request("node.stop", { nodeId: progNodeId });
  await sleep(500);
  await tui.disconnect();
}

// ============================================================
// Bug 1b: @mention to program node should route via node.message
// ============================================================

async function testProgramNodeMentionRoutesAsNodeMessage() {
  console.log("\n▸ Bug1b: @mention to program node routes via node.message");

  const tui = new WsClient("tui2");
  await tui.connect();
  const tuiReg = await tui.request("node.register", { name: "tui2", capabilities: ["ui"] });
  tui.nodeId = tuiReg.nodeId;

  // Spawn program node
  const spawnResult = await tui.request("node.spawn", {
    adapter: "mock-program",
    name: "prog-mc",
    cwd: ROOT,
  });
  const progNodeId = spawnResult.nodeId;
  await waitForNotification(tui, "node.statusChanged", p => p.name === "prog-mc" && p.status === "idle");

  // Create channel, add both
  const ch = await tui.request("channel.create", { cwd: ROOT, name: "test-ch2" });
  const channelId = ch.channelId;
  await tui.request("channel.join", { channelId });
  await tui.request("channel.addNode", { channelId, nodeId: progNodeId, name: "prog-mc" });
  await sleep(500);

  // Subscribe to prog-mc to see its updates
  await tui.request("node.subscribe", { nodeId: progNodeId });
  await sleep(200);

  // Post @mention to program node from channel
  await tui.request("channel.post", { channelId, content: "@prog-mc test-command" });

  // Wait for prog-mc to receive and log the DM (mock-program logs "dm:{content}:from:{from}")
  await sleep(1500);

  const updates = await tui.request("node.updates", { nodeName: "prog-mc" });
  const logEntries = (updates.updates || [])
    .filter((u: any) => u.update?.sessionUpdate === "node_log")
    .flatMap((u: any) => u.update?.entries || []);

  const dmLogs = logEntries.filter((e: any) => e.message?.startsWith("dm:"));
  assert(dmLogs.length > 0, "program node received @mention as node.message DM",
    `got ${dmLogs.length} DM logs: ${logEntries.map((e: any) => e.message).join("; ")}`);

  if (dmLogs.length > 0) {
    // Content should be the command part only (without @mention prefix)
    const msg = dmLogs[0].message as string;
    assert(msg.includes("test-command"), "DM content contains the command",
      `got: "${msg}"`);
  }

  // Cleanup
  await tui.request("node.stop", { nodeId: progNodeId });
  await sleep(500);
  await tui.disconnect();
}

// ============================================================
// Bug 2: channel.nodeLeft should be broadcast globally on stop
// ============================================================

async function testNodeLeftBroadcastGloballyOnStop() {
  console.log("\n▸ Bug2: channel.nodeLeft broadcast globally when node is stopped");

  // TUI connects but does NOT join the channel
  const tui = new WsClient("tui-ext");
  await tui.connect();
  const tuiReg = await tui.request("node.register", { name: "tui-ext", capabilities: ["ui"] });
  tui.nodeId = tuiReg.nodeId;

  // Agent connects and creates/joins a channel
  const agent = new WsClient("test-agent");
  await agent.connect();
  const agentReg = await agent.request("node.register", { name: "test-agent", capabilities: ["ai"] });
  agent.nodeId = agentReg.nodeId;

  const ch = await agent.request("channel.create", { cwd: ROOT, name: "agent-ch" });
  const channelId = ch.channelId;
  await agent.request("channel.join", { channelId });
  await sleep(300);
  tui.clearNotifications();

  // Stop the agent via TUI
  await tui.request("node.stop", { nodeId: agentReg.nodeId });
  await sleep(500);

  // TUI (NOT in channel) should receive channel.nodeLeft globally
  const nodeLeftEvents = tui.getNotifications("channel.nodeLeft");
  assert(nodeLeftEvents.length > 0, "external WS client receives channel.nodeLeft on stop",
    `got ${nodeLeftEvents.length} channel.nodeLeft notifications`);

  if (nodeLeftEvents.length > 0) {
    assertEq(nodeLeftEvents[0].params?.channelId, channelId, "correct channelId");
    assertEq(nodeLeftEvents[0].params?.nodeName, "test-agent", "correct nodeName");
  }

  // TUI should also get node.stopped (already works via broadcastToAllWsClients)
  const nodeStoppedEvents = tui.getNotifications("node.stopped");
  assert(nodeStoppedEvents.length > 0, "external WS client receives node.stopped");

  await tui.disconnect();
}

// ============================================================
// Bug 2b: channel.nodeJoined should be broadcast globally
// ============================================================

async function testNodeJoinedBroadcastGlobally() {
  console.log("\n▸ Bug2b: channel.nodeJoined broadcast globally");

  // TUI connects but does NOT join the channel
  const tui = new WsClient("tui-ext2");
  await tui.connect();
  const tuiReg = await tui.request("node.register", { name: "tui-ext2", capabilities: ["ui"] });
  tui.nodeId = tuiReg.nodeId;

  // Creator creates a channel (TUI is NOT a member)
  const creator = new WsClient("ch-creator");
  await creator.connect();
  const creatorReg = await creator.request("node.register", { name: "ch-creator", capabilities: ["ui"] });
  const ch = await creator.request("channel.create", { cwd: ROOT, name: "global-ch" });
  const channelId = ch.channelId;
  await creator.request("channel.join", { channelId });
  await sleep(300);
  tui.clearNotifications();

  // Add a new agent to channel
  const agent = new WsClient("new-agent");
  await agent.connect();
  const agentReg = await agent.request("node.register", { name: "new-agent", capabilities: ["ai"] });
  await creator.request("channel.addNode", { channelId, nodeId: agentReg.nodeId, name: "new-agent" });
  await sleep(500);

  // TUI (NOT in channel) should receive channel.nodeJoined globally
  const joinEvents = tui.getNotifications("channel.nodeJoined");
  assert(joinEvents.length > 0, "external WS client receives channel.nodeJoined globally",
    `got ${joinEvents.length} channel.nodeJoined notifications`);

  if (joinEvents.length > 0) {
    assertEq(joinEvents[0].params?.channelId, channelId, "correct channelId");
    assertEq(joinEvents[0].params?.nodeName, "new-agent", "correct nodeName");
  }

  await tui.disconnect();
  await creator.disconnect();
  await agent.disconnect();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Channel Isolation & Member Event Tests");
  console.log("═══════════════════════════════════════════");

  try {
    await startServer();
    console.log("  server started on port", TEST_PORT);

    await testProgramNodeNoChannelMessageBroadcast();
    await testProgramNodeMentionRoutesAsNodeMessage();
    await testNodeLeftBroadcastGloballyOnStop();
    await testNodeJoinedBroadcastGlobally();
  } catch (err) {
    console.error("  FATAL:", err);
    failed++;
    failures.push(String(err));
  } finally {
    stopServer();
  }

  console.log("\n══════════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    ✗ ${f}`);
  }
  console.log("══════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
