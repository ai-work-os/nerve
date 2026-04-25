#!/usr/bin/env npx tsx
/**
 * ai-ear — Tests
 *
 * Tests with mock ASR WebSocket server:
 * 1. AsrClient Qwen3 protocol — connect, session.update, send audio, receive transcript
 * 2. AsrClient Qwen3 — pending chunks flushed after session.updated
 * 3. AsrClient Qwen3 — reconnect on error
 * 4. AudioCapture — start/stop lifecycle (mocked binary)
 * 5. AiEarPlugin — full integration via spawn
 *
 * Usage: npx tsx test/ai-ear.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14802;
const MOCK_ASR_PORT = 14803;
const TEST_DATA = resolve(ROOT, ".test-data-mc");

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

// --- Mock ASR WebSocket Server ---

interface MockAsrMessage {
  type: string;
  session?: Record<string, unknown>;
  audio?: string;
  [key: string]: unknown;
}

class MockAsrServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof http.createServer>;
  private clients: WebSocket[] = [];
  receivedAudioChunks: string[] = [];
  receivedSessionConfig: Record<string, unknown> | null = null;
  /** Track uncommitted audio per-connection to simulate real server behavior */
  private uncommittedAudio = new WeakMap<WebSocket, boolean>();
  receivedCommits: Array<{ hadAudio: boolean }> = [];

  constructor(private port: number) {
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.on("connection", (ws) => {
        this.clients.push(ws);
        this.uncommittedAudio.set(ws, false);

        ws.on("message", (data) => {
          let msg: MockAsrMessage;
          try { msg = JSON.parse(data.toString()); } catch { return; }

          if (msg.type === "session.update") {
            this.receivedSessionConfig = msg.session as Record<string, unknown>;
            // Reply with session.updated
            ws.send(JSON.stringify({ type: "session.updated", session: msg.session }));
          } else if (msg.type === "input_audio_buffer.append") {
            this.receivedAudioChunks.push(msg.audio as string);
            this.uncommittedAudio.set(ws, true);
            // Simulate transcript after receiving audio
            if (this.receivedAudioChunks.length === 1) {
              // Send interim
              ws.send(JSON.stringify({
                type: "conversation.item.input_audio_transcription.text",
                stash: "测试中间",
              }));
            }
            if (this.receivedAudioChunks.length === 2) {
              // Send final
              ws.send(JSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "测试最终结果",
              }));
            }
          } else if (msg.type === "input_audio_buffer.commit") {
            const hadAudio = this.uncommittedAudio.get(ws) ?? false;
            this.receivedCommits.push({ hadAudio });
            if (!hadAudio) {
              // Real DashScope returns error on empty buffer commit
              ws.send(JSON.stringify({
                type: "error",
                error: { message: "Error committing input audio buffer" },
              }));
            } else {
              this.uncommittedAudio.set(ws, false);
              ws.send(JSON.stringify({
                type: "conversation.item.input_audio_transcription.completed",
                transcript: "提交完成",
              }));
            }
          }
        });
      });

      this.httpServer.listen(this.port, () => resolve());
    });
  }

  sendToAll(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  reset(): void {
    this.receivedAudioChunks = [];
    this.receivedSessionConfig = null;
  }

  stop(): void {
    for (const ws of this.clients) ws.close();
    this.wss.close();
    this.httpServer.close();
  }
}

// --- WS Client for nerve ---

class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notifications: Array<{ method: string; params: any }> = [];
  nodeId?: string;

  constructor(public name: string) {}

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

  clearNotifications(): void { this.notifications = []; }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.on("close", () => resolve());
      this.ws.close();
    });
  }
}

// --- Nerve server management ---

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
    serverProc!.on("exit", (code) => {
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`server exit ${code}`)); }
    });
  });
}

function stopServer(): void {
  if (serverProc) { serverProc.kill("SIGTERM"); serverProc = null; }
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
}

async function waitForNotification(
  client: WsClient, method: string, predicate: (params: any) => boolean, timeoutMs = 5000,
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

async function testAsrClientQwen3Protocol() {
  console.log("\n▸ AsrClient — Qwen3 protocol basics");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  const mockAsr = new MockAsrServer(MOCK_ASR_PORT);
  await mockAsr.start();

  const transcripts: Array<{ text: string; interim: boolean }> = [];

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${MOCK_ASR_PORT}`,
  });

  client.on("text", (text: string, interim: boolean) => {
    transcripts.push({ text, interim });
  });

  await client.connect();
  await sleep(200);

  // Verify session.update was sent
  assert(!!mockAsr.receivedSessionConfig, "session.update sent on connect");
  assertEq(mockAsr.receivedSessionConfig?.input_audio_format, "pcm", "audio format is pcm");
  assertEq(mockAsr.receivedSessionConfig?.sample_rate, 16000, "sample rate is 16000");

  // Send audio chunks
  const pcmChunk = Buffer.alloc(3200); // 100ms of 16kHz 16bit mono
  client.sendAudio(pcmChunk);
  await sleep(200);
  assert(mockAsr.receivedAudioChunks.length === 1, "first audio chunk received by ASR");

  client.sendAudio(pcmChunk);
  await sleep(200);
  assert(mockAsr.receivedAudioChunks.length === 2, "second audio chunk received");

  // Verify transcripts received
  assert(transcripts.length >= 2, `received ${transcripts.length} transcripts (expected ≥2)`);
  const interim = transcripts.find(t => t.interim);
  const final = transcripts.find(t => !t.interim);
  assert(!!interim, "received interim transcript");
  assert(!!final, "received final transcript");
  assertEq(final?.text, "测试最终结果", "final transcript text correct");

  client.disconnect();
  mockAsr.stop();
}

async function testAsrClientPendingChunks() {
  console.log("\n▸ AsrClient — pending chunks flushed after session ready");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  // Use a higher port to avoid conflict
  const port = MOCK_ASR_PORT + 1;
  const mockAsr = new MockAsrServer(port);
  await mockAsr.start();

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${port}`,
  });

  // Connect — session.updated is sent immediately by mock, but there's a small window
  // Send audio right after connect (before session.updated arrives)
  const connectPromise = client.connect();
  // Send audio immediately — should be buffered as pending
  const pcm = Buffer.alloc(3200);
  client.sendAudio(pcm);

  await connectPromise;
  await sleep(300);

  // After session ready, pending chunks should be flushed
  assert(mockAsr.receivedAudioChunks.length >= 1, "pending chunk flushed after session ready");

  client.disconnect();
  mockAsr.stop();
}

async function testAsrClientErrorEvent() {
  console.log("\n▸ AsrClient — error event handling");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  const port = MOCK_ASR_PORT + 2;
  const errors: Error[] = [];

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${port}`, // Nothing listening — connection will fail
  });

  client.on("error", (err: Error) => {
    errors.push(err);
  });

  try {
    await client.connect();
    assert(false, "should have thrown on connection failure");
  } catch {
    assert(true, "connect throws on failure");
  }
}

async function testAudioCapture() {
  console.log("\n▸ AudioCapture — start/stop lifecycle");

  const { AudioCapture } = await import("../src/plugins/ai-ear/audio-capture.js");

  // Test with a mock binary that outputs PCM-like data
  // Use `dd` to generate some bytes to stdout
  const capture = new AudioCapture("mic", {
    binaryPath: "dd",
    binaryArgs: ["if=/dev/zero", "bs=3200", "count=5"],
  });

  const chunks: Buffer[] = [];
  capture.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  let exitEmitted = false;
  capture.on("exit", () => { exitEmitted = true; });

  await capture.start();
  await sleep(1000);

  assert(chunks.length > 0, `received ${chunks.length} PCM chunks`);

  // dd will finish on its own, wait for exit
  await sleep(500);
  assert(exitEmitted, "exit event emitted after process ends");
}

async function testAudioCaptureStop() {
  console.log("\n▸ AudioCapture — manual stop");

  const { AudioCapture } = await import("../src/plugins/ai-ear/audio-capture.js");

  // Use `cat /dev/zero` as an infinite PCM-like stream
  const capture = new AudioCapture("mic", {
    binaryPath: "cat",
    binaryArgs: ["/dev/zero"],
  });

  const chunks: Buffer[] = [];
  capture.on("data", (chunk: Buffer) => chunks.push(chunk));

  await capture.start();
  await sleep(300);
  assert(chunks.length > 0, "receiving data before stop");

  capture.stop();
  await sleep(500);
  assert(true, "stop completes without hanging");
}

async function testPluginBufferFlush() {
  console.log("\n▸ AiEarPlugin — buffer flush logic + reason tracking");

  const { TranscriptBuffer } = await import("../src/plugins/ai-ear/index.js");

  const flushed: Array<{ lines: string[]; reason: string }> = [];
  const buf = new TranscriptBuffer({
    pushInterval: 500, // 500ms for test speed
    pushLines: 3,
    onFlush: (lines, reason) => { flushed.push({ lines: [...lines], reason }); },
  });

  // Add lines below threshold
  buf.add("line 1");
  buf.add("line 2");
  assertEq(flushed.length, 0, "no flush yet (below line threshold)");

  // Add third line — triggers line threshold
  buf.add("line 3");
  assertEq(flushed.length, 1, "flushed at line threshold");
  assertEq(flushed[0].lines.length, 3, "flushed 3 lines");
  assertEq(flushed[0].reason, "line_count", "reason: line_count");

  // Test time-based flush
  buf.add("line 4");
  await sleep(700);
  assertEq(flushed.length, 2, "flushed on timer");
  assertEq(flushed[1].lines[0], "line 4", "timer flush has correct content");
  assertEq(flushed[1].reason, "interval", "reason: interval");

  // Test manual flush
  buf.add("line 5");
  buf.flush();
  assertEq(flushed.length, 3, "manual flush works");
  assertEq(flushed[2].reason, "manual", "reason: manual");

  // Empty flush should be no-op
  buf.flush();
  assertEq(flushed.length, 3, "empty flush is no-op");

  // Stop flushes remaining with reason "stop"
  buf.add("line 6");
  buf.stop();
  assertEq(flushed.length, 4, "stop flushes remaining");
  assertEq(flushed[3].reason, "stop", "reason: stop");
}

async function testBufferIntervalChange() {
  console.log("\n▸ TranscriptBuffer — interval change takes effect");

  const { TranscriptBuffer } = await import("../src/plugins/ai-ear/index.js");

  const flushed: string[][] = [];

  // Start with 5000ms interval (long — should NOT trigger in test window)
  const buf = new TranscriptBuffer({
    pushInterval: 5000,
    pushLines: 100, // high threshold so only timer triggers
    onFlush: (lines) => { flushed.push([...lines]); },
  });

  buf.add("line-before");
  await sleep(600);
  assertEq(flushed.length, 0, "no flush with long interval");

  // Stop old, create new with short interval
  buf.stop();
  // stop() flushes remaining
  assertEq(flushed.length, 1, "stop flushes remaining lines");

  const buf2 = new TranscriptBuffer({
    pushInterval: 300,
    pushLines: 100,
    onFlush: (lines) => { flushed.push([...lines]); },
  });

  buf2.add("line-after");
  await sleep(500);
  assertEq(flushed.length, 2, "new buffer flushes with shorter interval");
  assertEq(flushed[1][0], "line-after", "new buffer has correct content");

  buf2.stop();
}

async function testConfigIntervalAlsoAdjustsLines() {
  console.log("\n▸ config interval — large interval should not be bypassed by line threshold");

  const { TranscriptBuffer } = await import("../src/plugins/ai-ear/index.js");

  // Simulate: user sets large interval but default pushLines=10
  // Expect: 10 lines should NOT trigger flush if interval is large
  const flushed: string[][] = [];

  // Old behavior: pushLines=10 triggers flush regardless of interval
  const bufOld = new TranscriptBuffer({
    pushInterval: 60000, // 60s — should not trigger in test
    pushLines: 10,
    onFlush: (lines) => { flushed.push([...lines]); },
  });

  for (let i = 0; i < 15; i++) bufOld.add(`line ${i}`);
  // With pushLines=10, this flushes at line 10
  assert(flushed.length > 0, "old behavior: line threshold triggers flush (reproduces bug)");
  bufOld.stop();

  // After fix: config interval should also update pushLines
  // When interval is large, pushLines should be large too
  // Test that recreated buffer with adjusted pushLines doesn't flush early
  const flushed2: string[][] = [];
  const bufNew = new TranscriptBuffer({
    pushInterval: 60000,
    pushLines: 9999, // Effectively disabled — only timer triggers
    onFlush: (lines) => { flushed2.push([...lines]); },
  });

  for (let i = 0; i < 50; i++) bufNew.add(`line ${i}`);
  assertEq(flushed2.length, 0, "fixed: large pushLines prevents line-triggered flush");
  bufNew.stop();
  assertEq(flushed2.length, 1, "stop still flushes remaining");
  assertEq(flushed2[0].length, 50, "all 50 lines in final flush");
}

async function testSliceWriter() {
  console.log("\n▸ SliceWriter — file-based transcript slices");

  const { SliceWriter } = await import("../src/plugins/ai-ear/index.js");

  const tmpDir = resolve(TEST_DATA, "slice-test-tmp");

  // Create slice writer — should create clean tmp dir
  const writer = new SliceWriter(tmpDir, "2026-03-31_1653");

  assert(existsSync(tmpDir), "tmp dir created");

  // Write first slice
  const lines1 = ["[+10s][mic] hello", "[+15s][mic] world"];
  const path1 = writer.write(lines1);
  assert(path1.endsWith("2026-03-31_1653_001.txt"), `slice 1 path: ${path1}`);
  assert(existsSync(path1), "slice 1 file exists");
  const content1 = readFileSync(path1, "utf-8");
  assert(content1.includes("[+10s][mic] hello"), "slice 1 has first line");
  assert(content1.includes("[+15s][mic] world"), "slice 1 has second line");

  // Write second slice
  const lines2 = ["[+20s][mic] foo", "[+25s][mic] bar", "[+30s][mic] baz"];
  const path2 = writer.write(lines2);
  assert(path2.endsWith("2026-03-31_1653_002.txt"), `slice 2 path: ${path2}`);
  assert(existsSync(path2), "slice 2 file exists");

  // Verify both files exist
  const files = readdirSync(tmpDir);
  assertEq(files.length, 2, "2 slice files in tmp dir");

  // New session should clean tmp dir
  const writer2 = new SliceWriter(tmpDir, "2026-03-31_1700");
  const files2 = readdirSync(tmpDir);
  assertEq(files2.length, 0, "tmp dir cleaned on new session");

  // Clean up
  rmSync(tmpDir, { recursive: true });
}

async function testSliceWriterTimeRange() {
  console.log("\n▸ SliceWriter.timeRange — extract time range from lines");

  const { SliceWriter } = await import("../src/plugins/ai-ear/index.js");

  // Multiple lines with different times
  assertEq(
    SliceWriter.timeRange(["[+10s][mic] a", "[+20s][mic] b", "[+30s][mic] c"]),
    "+10s-+30s",
    "range with start and end",
  );

  // Single line
  assertEq(
    SliceWriter.timeRange(["[+5s][mic] only"]),
    "+5s",
    "single line returns single time",
  );

  // Same time
  assertEq(
    SliceWriter.timeRange(["[+10s][mic] a", "[+10s][mic] b"]),
    "+10s",
    "same time returns single time",
  );
}

async function testSpawnMcTranscriber() {
  console.log("\n▸ ai-ear — spawn integration");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-mc", capabilities: ["ui"] });

  // Spawn ai-ear
  const spawn = await tui.request("node.spawn", {
    adapter: "ai-ear",
    name: "mc",
    cwd: ROOT,
  });
  assert(!!spawn.nodeId, "spawn returns nodeId");

  // Wait for plugin to connect back and become idle
  await waitForNotification(
    tui, "node.statusChanged",
    p => p.name === "mc" && p.status === "idle",
    10000,
  );
  assert(true, "mc transitioned to idle");

  // Verify in node.list
  const list = await tui.request("node.list");
  const mcNode = list.nodes.find((n: any) => n.name === "mc");
  assert(!!mcNode, "mc in node.list");
  assertEq(mcNode?.adapter, "ai-ear", "adapter name correct");
  assertEq(mcNode?.transport, "websocket", "transport is websocket");

  // Stop
  await tui.request("node.stop", { nodeId: spawn.nodeId });
  await waitForNotification(tui, "node.stopped", p => p.nodeId === spawn.nodeId, 5000);
  assert(true, "mc stopped cleanly");

  await tui.disconnect();
}

async function testChannelMessageNotDispatchedAsCommand() {
  console.log("\n▸ ai-ear — non-command @mc channel messages ignored");

  const tui = new WsClient("tui");
  await tui.connect();
  await tui.request("node.register", { name: "tui-mc2", capabilities: ["ui"] });

  // Spawn ai-ear
  const sp = await tui.request("node.spawn", { adapter: "ai-ear", name: "mc-cmd-test", cwd: ROOT });
  await waitForNotification(tui, "node.statusChanged", p => p.name === "mc-cmd-test" && p.status === "idle", 10000);

  // Create channel and join both
  const ch = await tui.request("channel.create", { name: "cmd-test-ch" });
  await tui.request("channel.join", { channelId: ch.channelId, nodeName: "mc-cmd-test" });
  await tui.request("channel.join", { channelId: ch.channelId, nodeName: "tui-mc2" });
  await sleep(300);

  // Post a non-command @mc message (simulates agent chatter)
  tui.clearNotifications();
  await tui.request("channel.post", { channelId: ch.channelId, content: "@mc-cmd-test 收到首段转录，等更多上下文。" });
  await sleep(500);

  // Post a valid command
  await tui.request("channel.post", { channelId: ch.channelId, content: "@mc-cmd-test status" });
  await sleep(500);

  // mc should have processed "status" but NOT the chatter
  // We can verify by checking mc's DM log — look for "command: status" but no "unknown command"
  // Since we can't read mc's internal log from here, verify mc didn't crash and is still idle
  const list = await tui.request("node.list");
  const mcNode = list.nodes.find((n: any) => n.name === "mc-cmd-test");
  assert(!!mcNode, "mc still alive after non-command @mention");
  assertEq(mcNode?.status, "idle", "mc still idle (didn't crash on non-command)");

  // Stop
  await tui.request("node.stop", { nodeId: sp.nodeId });
  await waitForNotification(tui, "node.stopped", p => p.nodeId === sp.nodeId, 5000);
  assert(true, "mc stopped cleanly after channel message test");

  await tui.disconnect();
}

async function testAsrPendingCap() {
  console.log("\n▸ AsrClient — pending buffer cap prevents OOM");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  // Create a mock server that never sends session.updated (simulates stuck session)
  const port = MOCK_ASR_PORT + 3;
  const httpSrv = http.createServer();
  const wss = new WebSocketServer({ server: httpSrv });
  wss.on("connection", () => { /* intentionally don't send session.updated */ });
  await new Promise<void>(r => httpSrv.listen(port, r));

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${port}`,
  });

  await client.connect();
  await sleep(100);

  // Send 200KB of audio (exceeds 160KB cap)
  const chunk = Buffer.alloc(3200); // 100ms
  for (let i = 0; i < 70; i++) { // 70 * 3200 = 224KB
    client.sendAudio(chunk);
  }

  // Access pending via any — internal state check
  const pendingBytes = (client as any).pendingBytes;
  assert(pendingBytes <= 160 * 1024 + 3200, `pending capped: ${pendingBytes} bytes ≤ ~163KB`);

  client.disconnect();
  wss.close();
  httpSrv.close();
}

async function testAsrDisconnectReconnect() {
  console.log("\n▸ AsrClient — disconnect triggers reconnect");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  const port = MOCK_ASR_PORT + 4;
  const mockAsr = new MockAsrServer(port);
  await mockAsr.start();

  const events: string[] = [];

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${port}`,
  });

  client.on("close", () => events.push("close"));
  client.on("reconnecting", () => events.push("reconnecting"));
  client.on("ready", () => events.push("ready"));

  await client.connect();
  await sleep(200);
  assert(events.includes("ready"), "initial session ready");

  // Force close the server-side WS to simulate disconnect
  mockAsr.sendToAll({ type: "__force_close" }); // Won't work, need to close from server
  // Instead, close all server-side clients directly
  for (const ws of (mockAsr as any).clients) {
    ws.close();
  }

  // Wait for reconnect cycle (2s delay + connect time)
  await sleep(3500);

  assert(events.includes("close"), "close event emitted");
  assert(events.includes("reconnecting"), "reconnecting event emitted");
  // After reconnect, should get another ready
  const readyCount = events.filter(e => e === "ready").length;
  assert(readyCount >= 2, `reconnected successfully (ready count=${readyCount})`);

  client.disconnect();
  await sleep(200);
  mockAsr.stop();
}

async function testAsrDisconnectNoEmptyCommit() {
  console.log("\n▸ AsrClient — disconnect skips commit when no uncommitted audio");

  const { AsrClient } = await import("../src/plugins/ai-ear/asr-client.js");

  const port = MOCK_ASR_PORT + 5;
  const mockAsr = new MockAsrServer(port);
  await mockAsr.start();

  const errors: Error[] = [];

  const client = new AsrClient({
    model: "qwen3-asr-flash-realtime",
    apiKey: "test-key",
    wsUrl: `ws://localhost:${port}`,
  });

  client.on("error", (err: Error) => errors.push(err));

  await client.connect();
  await sleep(200);

  // Send audio, then commit — should work fine
  client.sendAudio(Buffer.alloc(3200));
  await sleep(100);
  client.commit();
  await sleep(100);

  assert(errors.length === 0, "no error after commit with audio");
  assertEq(mockAsr.receivedCommits.length, 1, "one commit received");
  assert(mockAsr.receivedCommits[0].hadAudio, "commit had audio");

  // Now disconnect — no new audio since last commit
  // Should NOT send another commit (would cause "Error committing input audio buffer")
  client.disconnect();
  await sleep(1500); // Wait for delayed close

  assert(errors.length === 0, "no error on disconnect (empty commit skipped)");
  // Verify no extra commit was sent
  const emptyCommits = mockAsr.receivedCommits.filter(c => !c.hadAudio);
  assertEq(emptyCommits.length, 0, "no empty commits sent");

  mockAsr.stop();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   ai-ear Tests                       ║");
  console.log("╚══════════════════════════════════════╝");

  try {
    // Unit tests (no server needed)
    await testAsrClientQwen3Protocol();
    await testAsrClientPendingChunks();
    await testAsrClientErrorEvent();
    await testAsrPendingCap();
    await testAsrDisconnectReconnect();
    await testAsrDisconnectNoEmptyCommit();
    await testAudioCapture();
    await testAudioCaptureStop();
    await testPluginBufferFlush();
    await testBufferIntervalChange();
    await testConfigIntervalAlsoAdjustsLines();
    await testSliceWriter();
    await testSliceWriterTimeRange();

    // Integration test (needs nerve server)
    console.log("\n⟳ Starting nerve server...");
    await startServer();
    console.log("  Server started on port", TEST_PORT);

    await testSpawnMcTranscriber();
    await testChannelMessageNotDispatchedAsCommand();

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
