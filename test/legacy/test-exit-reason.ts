#!/usr/bin/env npx tsx
/**
 * agent 退出原因通知测试
 *
 * 验证：
 * 1. 手动 stop → 频道系统消息包含 reason=manual
 * 2. 手动 stop 频道消息格式：包含 agent 名 + "原因" + "已退出" + reason
 * 3. 停止后 node.stopped 广播包含 reason 字段
 *
 * 当前应该失败：系统消息还没有 reason 字段。
 *
 * 运行: cd nerve && npx tsx test/test-exit-reason.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_PORT = 14804;
const TEST_DATA = resolve(ROOT, ".test-data-exit-reason");

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

// --- WsClient ---

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

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

// --- Server lifecycle ---

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

// --- Helpers ---

/** Setup: register UI + agent, create channel, join both. Returns channelId + agent nodeId. */
async function setupChannelWithAgent(
  ui: WsClient,
  uiName: string,
  agentClient: WsClient,
  agentName: string,
  channelName: string,
): Promise<{ channelId: string; agentNodeId: string }> {
  await ui.request("node.register", { name: uiName, capabilities: ["monitor"], permissions: "admin" });

  const ch = await ui.request("channel.create", { cwd: ROOT, name: channelName });
  const channelId = ch.channelId;

  await agentClient.request("node.register", { name: agentName, capabilities: ["code"], permissions: "full" });

  await ui.request("channel.join", { channelId });
  await agentClient.request("channel.join", { channelId });

  // Find agent's nodeId
  const nodes = await ui.request("node.list", {});
  const agentNode = nodes.nodes.find((n: any) => n.name === agentName);
  return { channelId, agentNodeId: agentNode.id };
}

/** Stop agent and return system exit message from channel history (if any). */
async function stopAndGetExitMessage(
  ui: WsClient,
  agentNodeId: string,
  channelId: string,
  agentName: string,
): Promise<{ content: string } | undefined> {
  await ui.request("node.stop", { nodeId: agentNodeId });
  // Wait for system message to be posted
  await new Promise(r => setTimeout(r, 300));

  const hist = await ui.request("channel.history", { channelId });
  const messages = hist.messages || [];
  return messages.find((m: any) =>
    m.from === "系统" && m.content.includes(agentName)
  );
}

// --- Tests ---

async function test1_manualStopReasonManual() {
  console.log("\n▸ T1: 手动 stop → 频道系统消息包含 reason=manual");

  const ui = new WsClient();
  await ui.connect();
  const agent = new WsClient();
  await agent.connect();

  const { channelId, agentNodeId } = await setupChannelWithAgent(
    ui, "exit-ui-1", agent, "test-agent-1", "exit-test-ch-1",
  );

  const exitMsg = await stopAndGetExitMessage(ui, agentNodeId, channelId, "test-agent-1");

  assert(!!exitMsg, "system message found for agent exit",
    !exitMsg ? "no system message in channel history" : undefined);

  if (exitMsg) {
    assert(exitMsg.content.includes("manual"), "message contains reason=manual",
      `actual: "${exitMsg.content}"`);
  }

  await agent.disconnect();
  await ui.disconnect();
}

async function test2_messageFormat() {
  console.log("\n▸ T2: 手动 stop 频道消息格式：包含 agent 名 + '已退出' + '原因' + reason");

  const ui = new WsClient();
  await ui.connect();
  const agent = new WsClient();
  await agent.connect();

  const { channelId, agentNodeId } = await setupChannelWithAgent(
    ui, "exit-ui-2", agent, "test-agent-2", "exit-test-ch-2",
  );

  const exitMsg = await stopAndGetExitMessage(ui, agentNodeId, channelId, "test-agent-2");

  assert(!!exitMsg, "system exit message found");

  if (exitMsg) {
    const content = exitMsg.content as string;
    // Expected format: "${node.name} 已退出 (原因: ${reason}, exit: ${exitCode})"
    assert(content.includes("test-agent-2"), "message contains agent name",
      `actual: "${content}"`);
    assert(content.includes("已退出"), "message uses '已退出' instead of '已断开'",
      `actual: "${content}"`);
    assert(content.includes("原因"), "message contains '原因'",
      `actual: "${content}"`);
    assert(content.includes("manual"), "message contains reason value 'manual'",
      `actual: "${content}"`);
  }

  await agent.disconnect();
  await ui.disconnect();
}

async function test3_stoppedBroadcastIncludesReason() {
  console.log("\n▸ T3: node.stopped 广播包含 reason 字段");

  const ui = new WsClient();
  await ui.connect();
  const agent = new WsClient();
  await agent.connect();

  const { channelId, agentNodeId } = await setupChannelWithAgent(
    ui, "exit-ui-3", agent, "test-agent-3", "exit-test-ch-3",
  );

  await ui.request("node.stop", { nodeId: agentNodeId });
  await new Promise(r => setTimeout(r, 300));

  const stoppedNotifs = ui.getNotifications("node.stopped");
  const notif = stoppedNotifs.find((n: any) => n.params?.name === "test-agent-3");

  assert(!!notif, "node.stopped notification received");
  if (notif) {
    assert(notif.params.reason === "manual", "notification includes reason=manual",
      `actual reason: ${JSON.stringify(notif.params.reason)}`);
  }

  await agent.disconnect();
  await ui.disconnect();
}

async function test4_programNodeManualStopReasonManual() {
  console.log("\n▸ T4: 程序节点手动 stop → reason=manual（非 normal）");

  const { ChannelManager } = await import("../../src/channel/channel-manager.js");
  const { mkdirSync } = await import("node:fs");
  const EventEmitter = (await import("node:events")).default;
  const tmpDataDir = resolve(ROOT, ".test-data-exit-reason-t4");
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true });
  mkdirSync(tmpDataDir, { recursive: true });

  let stoppedReason: string | undefined;
  let stoppedName: string | undefined;
  const cm = new ChannelManager({ dataDir: tmpDataDir, port: 0 });
  cm.onNodeEvent = (event: string, node: any, detail?: any) => {
    if (event === "node.stopped") {
      stoppedReason = detail?.reason;
      stoppedName = node.name;
    }
  };

  // Register a WS node and mark as program node
  const ws = { readyState: 1, OPEN: 1, on() {}, send() {}, close() { this.readyState = 3; } } as any;
  const node = cm.nodePool.registerWebSocket(ws, "prog-agent-stop", ["code"], "full");

  // Fake process: emits "exit" on kill (simulates real process behavior)
  const fakeProc = Object.assign(new EventEmitter(), {
    pid: 77777,
    kill(sig?: string) {
      setTimeout(() => this.emit("exit", 0), 50);
    },
  });
  cm.nodePool.trackProgramProcess(node.id, fakeProc as any);

  // Wire up exit handler like spawnProgramNode does (line 387-390)
  fakeProc.on("exit", (code: number) => {
    const reason = (cm.nodePool as any)._computeExitReason(code, node);
    (cm.nodePool as any)._cleanupNode(node.id, { newStatus: "stopped", removeFromPool: true, exitCode: code, reason });
  });

  // Create channel and add node
  const ch = cm.createChannel(tmpDataDir, "prog-stop-ch");
  cm.addNodeToChannel(ch.id, node.id);

  // Stop the node — goes through program node path (sets _manualStop, kills proc)
  await cm.nodePool.stopNode(node.id);
  await new Promise(r => setTimeout(r, 200));

  assert(stoppedName === "prog-agent-stop", "node.stopped event fired for prog-agent-stop");
  assert(stoppedReason === "manual", "program node stop reason is 'manual'",
    `actual: "${stoppedReason}"`);

  // Check channel system message
  const messages = cm.getHistory(ch.id);
  const exitMsg = messages.find((m: any) => m.from === "系统" && m.content.includes("prog-agent-stop"));
  assert(!!exitMsg, "program node exit system message found");
  if (exitMsg) {
    assert(exitMsg.content.includes("manual"), "program node exit message contains 'manual'",
      `actual: "${exitMsg.content}"`);
  }

  // Cleanup
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true });
}

// --- Main ---

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  agent 退出原因通知测试");
  console.log("═══════════════════════════════════════");

  // T4 runs without server (unit test)
  await test4_programNodeManualStopReasonManual();

  try {
    await startServer();
    console.log(`  server started on port ${TEST_PORT}`);
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }

  try {
    await test1_manualStopReasonManual();
    await test2_messageFormat();
    await test3_stoppedBroadcastIncludesReason();
  } finally {
    stopServer();
  }

  console.log("\n" + "═".repeat(40));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
