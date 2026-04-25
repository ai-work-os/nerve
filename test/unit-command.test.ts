#!/usr/bin/env npx tsx
/**
 * Unit tests for /node/command — requires server.
 * Focused: only tests command routing, no other tests.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14802;
const TEST_DATA = resolve(ROOT, ".test-data-command");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function httpPost(path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: "localhost", port: TEST_PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); } });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// WS helper
class WsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && !msg.method) {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
        }
      });
    });
  }

  async request(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async disconnect(): Promise<void> { this.ws.close(); }
}

// --- Main ---
async function run() {
  // Clean test data
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  // Start server
  const server = spawn("npx", ["tsx", "src/cli.ts", "serve", "--port", String(TEST_PORT), "--data", TEST_DATA, "--no-guardian", "--no-recorder"], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NERVE_LOG_LEVEL: "warn" },
  });

  // Wait for server ready
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await httpPost("/node/list", {});
      if (res.nodes) break;
    } catch {}
  }

  try {
    console.log("\n▸ /node/command: basic flow");

    const c = new WsClient();
    await c.connect();
    await c.request("node.register", { name: "cmd-tester", capabilities: ["ui"] });

    // Spawn mock-program
    const sp = await c.request("node.spawn", { adapter: "mock-program", name: "cmd-target", cwd: ROOT });
    assert(!!sp.nodeId, "program spawned");

    // Wait for idle
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const nodes = await c.request("node.list");
      if (nodes.nodes.find((n: any) => n.name === "cmd-target" && n.status === "idle")) break;
    }

    // Test: status command
    const statusResult = await httpPost("/node/command", {
      nodeName: "cmd-target", command: "status", args: {}, from: "test-caller",
    });
    assert(!statusResult.error, "status: no error", JSON.stringify(statusResult));
    assert(typeof statusResult.reply === "string", "status: got reply", JSON.stringify(statusResult));
    assert(typeof statusResult.reply === "string" && (statusResult.reply as string).includes("from=test-caller"), "status: reply contains caller", String(statusResult.reply));

    // Test: ping command
    const pingResult = await httpPost("/node/command", {
      nodeName: "cmd-target", command: "ping",
    });
    assert(!pingResult.error, "ping: no error");
    assert(pingResult.reply === "pong", "ping: reply is pong", JSON.stringify(pingResult));

    // Test: unknown command
    const unknownResult = await httpPost("/node/command", {
      nodeName: "cmd-target", command: "nonexistent",
    });
    assert(!!unknownResult.error, "unknown command: returns error");

    // Test: non-existent node
    const noNodeResult = await httpPost("/node/command", {
      nodeName: "does-not-exist", command: "status",
    });
    assert(!!noNodeResult.error, "non-existent node: returns error");

    // Test: missing params
    const noCmd = await httpPost("/node/command", { nodeName: "cmd-target" });
    assert(!!noCmd.error, "missing command: returns error");

    // Cleanup
    await c.request("node.stop", { nodeId: sp.nodeId });
    await c.disconnect();

  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) { console.log("Failures:", failures); }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
