/**
 * Shared test helpers for vitest migration.
 * Provides WsClient, McpToolClient, HTTP helpers, server management,
 * and assert wrappers that bridge the old custom framework to vitest's expect.
 */

import { expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "../..");

// --- Dynamic port and data dir ---

let _testPort = 0;
let _testData = "";

export function getTestPort(): number {
  return _testPort;
}

export function getTestData(): string {
  return _testData;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

// --- Assert wrappers (bridge old framework to vitest expect) ---

export function assert(condition: boolean, name: string, detail?: string): void {
  const msg = detail ? `${name}: ${detail}` : name;
  expect(condition, msg).toBe(true);
}

export function assertEq(actual: unknown, expected: unknown, name: string): void {
  expect(actual, name).toEqual(expected);
}

export function assertNoThrow(fn: () => void, name: string): void {
  expect(() => fn(), name).not.toThrow();
}

// --- Utility ---

export async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- HTTP helpers ---

export function httpPost(path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: "localhost",
      port: _testPort,
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

export function httpGet(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${_testPort}${path}`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`invalid json: ${d}`)); }
      });
    }).on("error", reject);
  });
}

export function httpGetText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${_testPort}${path}`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

// --- WebSocket client ---

export class WsClient {
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
    this.ws = new WebSocket(`ws://localhost:${_testPort}`);
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

  close(): void {
    this.ws.close();
  }
}

// --- MCP Tool Client ---

export class McpToolClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(nodeName: string) {
    this.client = new Client({ name: "self-test", version: "0.1.0" });
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp/nerve-mcp.ts"],
      cwd: ROOT,
      env: {
        ...process.env,
        NERVE_PORT: String(_testPort),
        NERVE_NODE_NAME: nodeName,
      } as Record<string, string>,
      stderr: "pipe",
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<any[]> {
    const r = await this.client.listTools();
    return r.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

// --- Notification wait helper ---

export async function waitForNotification(
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

// --- Server process management ---

let serverProc: ChildProcess | null = null;
export const serverLogBuffer: string[] = [];

export async function startServer(): Promise<void> {
  _testPort = await findFreePort();
  _testData = `/tmp/nerve-test-${_testPort}`;

  // Clean test data
  if (existsSync(_testData)) rmSync(_testData, { recursive: true });

  // Create test scene config
  const scenesDir = resolve(_testData, "scenes");
  mkdirSync(scenesDir, { recursive: true });
  writeFileSync(resolve(scenesDir, "test-scene.json"), JSON.stringify({
    name: "test-scene",
    nodes: [
      { adapter: "mock-program", name: "scene-mock-1" },
    ],
    channel: { name: "test-meeting", auto_create: true },
    on_ready: [],
  }));

  writeFileSync(resolve(scenesDir, "test-scene-stdio.json"), JSON.stringify({
    name: "test-scene-stdio",
    nodes: [
      { adapter: "mock", name: "scene-ai-1" },
    ],
    channel: { name: "test-stdio-ch", auto_create: true },
    on_ready: [
      { to: "scene-ai-1", command: "hello from scene", prompt: true },
    ],
  }));

  writeFileSync(resolve(scenesDir, "test-scene-warn.json"), JSON.stringify({
    name: "test-scene-warn",
    nodes: [
      { adapter: "mock-program", name: "scene-warn-1" },
    ],
    channel: { name: "test-warn-ch", auto_create: true },
    on_ready: [
      { to: "ghost-node", command: "start" },
    ],
  }));

  serverProc = spawn("npx", ["tsx", "src/index.ts", "--port", String(_testPort), "--data", _testData], {
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
      for (const line of s.split("\n")) {
        if (line.trim()) serverLogBuffer.push(line);
      }
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

export function stopServer(): void {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
  if (existsSync(_testData)) rmSync(_testData, { recursive: true });
}

// Re-export for convenience
export { resolve, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync };
export { WebSocket };
