#!/usr/bin/env npx tsx
/**
 * ACP Client Unit Tests
 *
 * Tests for SDK migration coverage (review #9):
 * 1. transportToStream notification interception
 * 2. ClientSideConnection Client handlers (readTextFile, writeTextFile, terminal)
 * 3. newSessionWithRetry retry path
 * 4. prompt timeout state recovery
 *
 * Run: npx tsx test/acp-client.test.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { AcpClient, type AcpClientOptions } from "../../src/agent/acp-client.js";
import type { StdioTransport } from "../../src/transport/transport.js";
import type { JsonRpcMessage } from "../../src/transport/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = resolve(__dirname, "..", ".test-data-acp-client");

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

// --- Mock Transport ---

type MessageHandler = (msg: JsonRpcMessage) => void;

/**
 * Mock StdioTransport that simulates an ACP agent process.
 * - Captures messages sent by AcpClient
 * - Allows injecting messages from the "agent" side
 * - Can auto-respond to ACP handshake methods
 */
class MockAgentTransport {
  private msgHandler: MessageHandler | null = null;
  private closeHandler: ((code: number | null) => void) | null = null;
  sent: any[] = [];
  private autoResponders = new Map<string, (id: number | string, params: any) => any>();
  private sessionNewFailCount = 0;

  get alive() { return true; }
  get type() { return "stdio" as const; }
  get pid() { return 99999; }

  onMessage(handler: MessageHandler): void {
    this.msgHandler = handler;
  }

  onClose(handler: (code: number | null) => void): void {
    this.closeHandler = handler;
  }

  send(msg: JsonRpcMessage): void {
    this.sent.push(msg);
    const m = msg as any;

    // Auto-respond to requests
    if (m.id !== undefined && m.method) {
      const responder = this.autoResponders.get(m.method);
      if (responder) {
        const result = responder(m.id, m.params);
        if (result !== undefined) {
          // Async inject to simulate agent processing
          setTimeout(() => this.inject({
            jsonrpc: "2.0",
            id: m.id,
            result,
          }), 1);
        }
      }
    }
  }

  close(): void {}

  /** Inject a message from the agent side */
  inject(msg: any): void {
    this.msgHandler?.(msg);
  }

  /** Register an auto-responder for a method */
  onMethod(method: string, handler: (id: number | string, params: any) => any): void {
    this.autoResponders.set(method, handler);
  }

  /** Configure session/new to fail N times before succeeding */
  setSessionNewFailCount(n: number): void {
    this.sessionNewFailCount = n;
  }

  /** Set up standard handshake auto-responses */
  setupHandshake(opts?: { sessionId?: string }): void {
    const sid = opts?.sessionId ?? "test-session-1";

    this.onMethod("initialize", () => ({
      protocolVersion: 1,
      agentInfo: { name: "test-agent", version: "0.1.0" },
      agentCapabilities: {},
    }));

    this.onMethod("authenticate", () => ({}));

    this.onMethod("session/new", () => {
      if (this.sessionNewFailCount > 0) {
        this.sessionNewFailCount--;
        // Return undefined to signal we'll inject an error manually
        return undefined;
      }
      return { sessionId: sid };
    });

    // Override send to handle session/new failures
    const origSend = this.send.bind(this);
    this.send = (msg: JsonRpcMessage) => {
      const m = msg as any;
      if (m.id !== undefined && m.method === "session/new" && this.sessionNewFailCount > 0) {
        this.sessionNewFailCount--;
        this.sent.push(msg);
        setTimeout(() => this.inject({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32000, message: "session creation failed (transient)" },
        }), 1);
        return;
      }
      origSend(msg);
    };

    this.onMethod("session/prompt", () => {
      // Default: return end_turn immediately
      return { stopReason: "end_turn" };
    });

    this.onMethod("listSessions", () => ({
      sessions: [],
    }));
  }

  /** Get sent requests for a specific method */
  getSent(method: string): any[] {
    return this.sent.filter((m: any) => m.method === method);
  }
}

function createMockClient(overrides?: Partial<AcpClientOptions>): {
  client: AcpClient;
  transport: MockAgentTransport;
} {
  const transport = new MockAgentTransport();
  transport.setupHandshake();

  const client = new AcpClient({
    transport: transport as unknown as StdioTransport,
    cwd: TMP_DIR,
    ...overrides,
  });

  return { client, transport };
}

// =============================================================================
// Test 1: transportToStream notification interception
// =============================================================================

async function testTransportToStreamInterception() {
  console.log("\n── transportToStream notification interception ──");

  // session/update notifications should be intercepted and forwarded to onUpdate
  const updates: any[] = [];
  const { client, transport } = createMockClient({
    onUpdate: (params) => updates.push(params),
  });

  await client.handshake();
  await sleep(50);

  // Inject a session/update notification (no id → notification)
  transport.inject({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "test-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    },
  });

  await sleep(50);
  assert(updates.length === 1, "session/update intercepted and forwarded to onUpdate");
  assertEq(
    (updates[0] as any)?.update?.sessionUpdate,
    "agent_message_chunk",
    "update content preserved",
  );

  // Inject a non-standard sessionUpdate value (the reason we bypass SDK Zod)
  transport.inject({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "test-session-1",
      update: { sessionUpdate: "custom_nonstandard_value", data: "test" },
    },
  });

  await sleep(50);
  assert(updates.length === 2, "non-standard sessionUpdate also intercepted");
  assertEq(
    (updates[1] as any)?.update?.sessionUpdate,
    "custom_nonstandard_value",
    "non-standard update value preserved",
  );

  // Verify that a session/update WITH an id (request, not notification) is NOT intercepted
  // This would be passed through to the SDK as a normal message
  const updatesBefore = updates.length;
  transport.inject({
    jsonrpc: "2.0",
    id: 999,
    method: "session/update",
    params: { sessionId: "test-session-1", update: {} },
  });

  await sleep(50);
  assertEq(updates.length, updatesBefore, "session/update with id (request) NOT intercepted");

  client.cleanup();
}

// =============================================================================
// Test 2: Client handlers (readTextFile, writeTextFile, terminal)
// =============================================================================

async function testClientHandlerReadTextFile() {
  console.log("\n── Client handler: readTextFile ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  // Create a test file
  const testFile = resolve(TMP_DIR, "read-test.txt");
  writeFileSync(testFile, "line0\nline1\nline2\nline3\nline4", "utf8");

  // Agent sends readTextFile reverse request
  transport.inject({
    jsonrpc: "2.0",
    id: 1001,
    method: "fs/read_text_file",
    params: { sessionId: "test-session-1", path: testFile },
  });

  await sleep(100);

  // Find the response in sent messages
  const response = transport.sent.find((m: any) => m.id === 1001 && !m.method);
  assert(response !== undefined, "readTextFile response sent");
  assert(response?.result?.content?.includes("line0"), "readTextFile returns file content");

  // Test with line/limit params
  transport.inject({
    jsonrpc: "2.0",
    id: 1002,
    method: "fs/read_text_file",
    params: { sessionId: "test-session-1", path: testFile, line: 1, limit: 2 },
  });

  await sleep(100);

  const response2 = transport.sent.find((m: any) => m.id === 1002 && !m.method);
  assert(response2 !== undefined, "readTextFile with line/limit response sent");
  assertEq(response2?.result?.content, "line1\nline2", "readTextFile slices correctly");

  // Test missing file → returns empty content
  transport.inject({
    jsonrpc: "2.0",
    id: 1003,
    method: "fs/read_text_file",
    params: { sessionId: "test-session-1", path: "/nonexistent/file.txt" },
  });

  await sleep(100);

  const response3 = transport.sent.find((m: any) => m.id === 1003 && !m.method);
  assert(response3 !== undefined, "readTextFile missing file response sent");
  assertEq(response3?.result?.content, "", "missing file returns empty content");

  client.cleanup();
}

async function testClientHandlerWriteTextFile() {
  console.log("\n── Client handler: writeTextFile ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  const testFile = resolve(TMP_DIR, "subdir", "write-test.txt");

  // Agent sends writeTextFile reverse request
  transport.inject({
    jsonrpc: "2.0",
    id: 2001,
    method: "fs/write_text_file",
    params: { sessionId: "test-session-1", path: testFile, content: "hello from agent" },
  });

  await sleep(100);

  const response = transport.sent.find((m: any) => m.id === 2001 && !m.method);
  assert(response !== undefined, "writeTextFile response sent");
  assert(!response?.error, "writeTextFile no error");

  // Verify file was actually written
  const written = readFileSync(testFile, "utf8");
  assertEq(written, "hello from agent", "writeTextFile creates file with content");

  // Verify mkdirSync created parent directories
  assert(existsSync(resolve(TMP_DIR, "subdir")), "writeTextFile creates parent directories");

  client.cleanup();
}

async function testClientHandlerTerminal() {
  console.log("\n── Client handler: terminal lifecycle ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  // createTerminal
  transport.inject({
    jsonrpc: "2.0",
    id: 3001,
    method: "terminal/create",
    params: { sessionId: "test-session-1", command: "echo", args: ["hello-terminal"] },
  });

  await sleep(500); // Give process time to run

  const createResp = transport.sent.find((m: any) => m.id === 3001 && !m.method);
  assert(createResp !== undefined, "createTerminal response sent");
  const termId = createResp?.result?.terminalId;
  assert(typeof termId === "string" && termId.length > 0, "createTerminal returns terminalId");

  // waitForTerminalExit
  transport.inject({
    jsonrpc: "2.0",
    id: 3002,
    method: "terminal/wait_for_exit",
    params: { sessionId: "test-session-1", terminalId: termId },
  });

  await sleep(500);

  const waitResp = transport.sent.find((m: any) => m.id === 3002 && !m.method);
  assert(waitResp !== undefined, "waitForTerminalExit response sent");
  assertEq(waitResp?.result?.exitCode, 0, "echo command exits with code 0");

  // terminalOutput
  transport.inject({
    jsonrpc: "2.0",
    id: 3003,
    method: "terminal/output",
    params: { sessionId: "test-session-1", terminalId: termId },
  });

  await sleep(100);

  const outputResp = transport.sent.find((m: any) => m.id === 3003 && !m.method);
  assert(outputResp !== undefined, "terminalOutput response sent");
  assert(
    outputResp?.result?.output?.includes("hello-terminal"),
    "terminalOutput contains command output",
  );

  // releaseTerminal
  transport.inject({
    jsonrpc: "2.0",
    id: 3004,
    method: "terminal/release",
    params: { sessionId: "test-session-1", terminalId: termId },
  });

  await sleep(100);

  const releaseResp = transport.sent.find((m: any) => m.id === 3004 && !m.method);
  assert(releaseResp !== undefined, "releaseTerminal response sent");
  assert(!releaseResp?.error, "releaseTerminal no error");

  // terminalOutput after release → error
  transport.inject({
    jsonrpc: "2.0",
    id: 3005,
    method: "terminal/output",
    params: { sessionId: "test-session-1", terminalId: termId },
  });

  await sleep(100);

  const afterRelease = transport.sent.find((m: any) => m.id === 3005 && !m.method);
  assert(afterRelease !== undefined, "terminalOutput after release response sent");
  assert(afterRelease?.error !== undefined, "terminalOutput after release returns error");

  client.cleanup();
}

async function testClientHandlerKillTerminal() {
  console.log("\n── Client handler: killTerminal ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  // Create a short-lived terminal to test kill + waitForExit
  transport.inject({
    jsonrpc: "2.0",
    id: 4001,
    method: "terminal/create",
    params: { sessionId: "test-session-1", command: "sleep", args: ["0.1"] },
  });

  await sleep(200);

  const createResp = transport.sent.find((m: any) => m.id === 4001 && !m.method);
  const termId = createResp?.result?.terminalId;
  assert(typeof termId === "string", "terminal created for kill test");

  // Kill it (process may already have exited, kill should still not error)
  transport.inject({
    jsonrpc: "2.0",
    id: 4002,
    method: "terminal/kill",
    params: { sessionId: "test-session-1", terminalId: termId },
  });

  await sleep(300);

  const killResp = transport.sent.find((m: any) => m.id === 4002 && !m.method);
  assert(killResp !== undefined, "killTerminal response sent");
  assert(!killResp?.error, "killTerminal no error");

  // Kill non-existent terminal → error
  transport.inject({
    jsonrpc: "2.0",
    id: 4003,
    method: "terminal/kill",
    params: { sessionId: "test-session-1", terminalId: "nonexistent" },
  });

  await sleep(100);

  const killBadResp = transport.sent.find((m: any) => m.id === 4003 && !m.method);
  assert(killBadResp !== undefined, "killTerminal nonexistent response sent");
  assert(killBadResp?.error !== undefined, "killTerminal nonexistent returns error");

  client.cleanup();
}

async function testClientHandlerRequestPermission() {
  console.log("\n── Client handler: requestPermission ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  // Agent sends requestPermission with options
  transport.inject({
    jsonrpc: "2.0",
    id: 5001,
    method: "session/request_permission",
    params: {
      sessionId: "test-session-1",
      toolCall: { toolCallId: "tc-1", title: "Read file", kind: "read" },
      options: [
        { optionId: "deny", kind: "reject_once", name: "Deny" },
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow-always", kind: "allow_always", name: "Allow always" },
      ],
    },
  });

  await sleep(100);

  const resp = transport.sent.find((m: any) => m.id === 5001 && !m.method);
  assert(resp !== undefined, "requestPermission response sent");
  assertEq(resp?.result?.outcome?.outcome, "selected", "requestPermission outcome is 'selected'");
  // Should pick allow_once (first allow option)
  assertEq(resp?.result?.outcome?.optionId, "allow-once", "auto-approves with allow_once");

  client.cleanup();
}

// =============================================================================
// Test 3: newSessionWithRetry retry path
// =============================================================================

async function testNewSessionWithRetry() {
  console.log("\n── newSessionWithRetry retry path ──");

  const transport = new MockAgentTransport();

  // Set up handshake with 2 session/new failures before success
  transport.onMethod("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "test-agent", version: "0.1.0" },
    agentCapabilities: {},
  }));

  let sessionNewAttempts = 0;
  // Manually handle session/new to control failures
  transport.onMethod("session/new", (id, params) => {
    sessionNewAttempts++;
    if (sessionNewAttempts <= 2) {
      return undefined; // Signal: don't auto-respond, we'll inject error
    }
    return { sessionId: "retry-session-ok" };
  });

  // Override send to inject errors for early attempts
  const origSend = transport.send.bind(transport);
  transport.send = (msg: JsonRpcMessage) => {
    const m = msg as any;
    if (m.method === "session/new" && m.id !== undefined) {
      transport.sent.push(msg);
      sessionNewAttempts++;
      if (sessionNewAttempts <= 2) {
        setTimeout(() => transport.inject({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32000, message: "transient failure" },
        }), 1);
        return;
      }
      // Third attempt: succeed
      setTimeout(() => transport.inject({
        jsonrpc: "2.0",
        id: m.id,
        result: { sessionId: "retry-session-ok" },
      }), 1);
      return;
    }
    origSend(msg);
  };

  let readySessionId: string | undefined;
  const client = new AcpClient({
    transport: transport as unknown as StdioTransport,
    cwd: TMP_DIR,
    onReady: (sid) => { readySessionId = sid; },
  });

  await client.handshake();
  // Wait for retry delays (1s each) + processing
  await sleep(3000);

  assertEq(sessionNewAttempts, 3, "session/new attempted 3 times (2 failures + 1 success)");
  assertEq(readySessionId, "retry-session-ok", "handshake succeeds after retries");
  assertEq(client.sessionId, "retry-session-ok", "sessionId set after retry success");

  client.cleanup();
}

async function testNewSessionWithRetryExhausted() {
  console.log("\n── newSessionWithRetry exhausted retries ──");

  const transport = new MockAgentTransport();

  transport.onMethod("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "test-agent", version: "0.1.0" },
    agentCapabilities: {},
  }));

  // Always fail session/new
  const origSend = transport.send.bind(transport);
  let attempts = 0;
  transport.send = (msg: JsonRpcMessage) => {
    const m = msg as any;
    if (m.method === "session/new" && m.id !== undefined) {
      transport.sent.push(msg);
      attempts++;
      setTimeout(() => transport.inject({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32000, message: "permanent failure" },
      }), 1);
      return;
    }
    origSend(msg);
  };

  let errorMsg: string | undefined;
  const client = new AcpClient({
    transport: transport as unknown as StdioTransport,
    cwd: TMP_DIR,
    onError: (err) => { errorMsg = err; },
  });

  await client.handshake();
  await sleep(4000);

  assertEq(attempts, 3, "session/new attempted 3 times (retries=2 → 3 total)");
  assert(errorMsg !== undefined, "onError called when retries exhausted");
  assert(errorMsg!.includes("handshake failed"), "error message indicates handshake failure");
  assertEq(client.sessionId, undefined, "sessionId remains undefined on failure");

  client.cleanup();
}

// =============================================================================
// Test 4: prompt timeout state recovery
// =============================================================================

async function testPromptTimeoutStateRecovery() {
  console.log("\n── prompt timeout state recovery ──");

  const transport = new MockAgentTransport();
  transport.setupHandshake();

  // Override session/prompt to never respond (simulate hang)
  const origSend = transport.send.bind(transport);
  transport.send = (msg: JsonRpcMessage) => {
    const m = msg as any;
    if (m.method === "session/prompt" && m.id !== undefined) {
      transport.sent.push(msg);
      // Don't respond — let it timeout
      return;
    }
    origSend(msg);
  };

  const client = new AcpClient({
    transport: transport as unknown as StdioTransport,
    cwd: TMP_DIR,
    promptTimeout: 200, // 200ms for fast test
  });

  await client.handshake();
  await sleep(50);

  // Verify session established
  assert(client.sessionId !== undefined, "session established before prompt");

  // Send prompt — should timeout
  const result = await client.prompt("this will timeout");

  assert(result.error !== undefined, "prompt returns error on timeout");
  assert(result.error!.includes("timeout"), "error message mentions timeout");
  assert(result.error!.includes("200ms"), "error message includes timeout duration");

  // Verify state recovery: promptInFlight should be false
  // We test this indirectly via cancel() — should return "no active prompt"
  const cancelResult = await client.cancel();
  assertEq(cancelResult.error, "no active prompt", "promptInFlight reset after timeout (cancel returns no active prompt)");

  // Verify we can send another prompt after timeout
  // Re-enable prompt responses
  transport.onMethod("session/prompt", () => ({ stopReason: "end_turn" }));
  transport.send = origSend;

  const result2 = await client.prompt("after timeout");
  assertEq(result2.stopReason, "end_turn", "prompt works after timeout recovery");

  client.cleanup();
}

async function testPromptNormalStateManagement() {
  console.log("\n── prompt normal state management ──");

  const { client, transport } = createMockClient();
  await client.handshake();
  await sleep(50);

  // Before prompt: cancel should fail
  const cancelBefore = await client.cancel();
  assertEq(cancelBefore.error, "no active prompt", "cancel before prompt returns no active prompt");

  // Prompt completes normally
  const result = await client.prompt("hello");
  assertEq(result.stopReason, "end_turn", "prompt returns end_turn");

  // After prompt: cancel should fail again
  const cancelAfter = await client.cancel();
  assertEq(cancelAfter.error, "no active prompt", "cancel after prompt returns no active prompt");

  client.cleanup();
}

async function testPromptImageBlocks() {
  console.log("\n── prompt image blocks ──");

  const { client, transport } = createMockClient();
  let promptParams: any;
  transport.onMethod("session/prompt", (_id, params) => {
    promptParams = params;
    return { stopReason: "end_turn" };
  });
  await client.handshake();
  await sleep(50);

  const result = await client.prompt("look", [{ type: "image", mimeType: "image/png", data: "abc123" }]);

  assertEq(result.stopReason, "end_turn", "prompt with image returns end_turn");
  assertEq(
    promptParams.prompt,
    [
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "abc123" },
    ],
    "prompt sends text and image blocks",
  );

  client.cleanup();
}

async function testPromptNoSession() {
  console.log("\n── prompt without session ──");

  const transport = new MockAgentTransport();
  // Don't set up handshake — no session

  const client = new AcpClient({
    transport: transport as unknown as StdioTransport,
    cwd: TMP_DIR,
  });

  // No handshake → no sessionId
  const result = await client.prompt("no session");
  assertEq(result.error, "no session", "prompt without session returns error");

  const cancelResult = await client.cancel();
  assertEq(cancelResult.error, "no session", "cancel without session returns error");

  client.cleanup();
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  ACP Client Unit Tests");
  console.log("═══════════════════════════════════════");

  // Setup
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  try {
    // 1. transportToStream notification interception
    await testTransportToStreamInterception();

    // 2. Client handlers
    await testClientHandlerReadTextFile();
    await testClientHandlerWriteTextFile();
    await testClientHandlerTerminal();
    await testClientHandlerKillTerminal();
    await testClientHandlerRequestPermission();

    // 3. newSessionWithRetry retry path
    await testNewSessionWithRetry();
    await testNewSessionWithRetryExhausted();

    // 4. prompt timeout state recovery
    await testPromptTimeoutStateRecovery();
    await testPromptNormalStateManagement();
    await testPromptImageBlocks();
    await testPromptNoSession();
  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    failed++;
  } finally {
    // Cleanup
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
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
