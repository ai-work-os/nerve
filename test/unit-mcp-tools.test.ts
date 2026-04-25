#!/usr/bin/env npx tsx
/**
 * Unit tests for nerve_command and nerve_capabilities MCP tools.
 * Starts its own nerve server + nerve-mcp process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_PORT = 14804;
const TEST_DATA = resolve(ROOT, ".test-data-mcp-tools");

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

function httpPost(path: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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

class McpToolClient {
  private client!: Client;
  private transport!: StdioClientTransport;

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", resolve(ROOT, "src/nerve-mcp.ts")],
      env: {
        ...process.env,
        NERVE_PORT: String(TEST_PORT),
        NERVE_NODE_NAME: "mcp-test-agent",
      },
    });
    this.client = new Client({ name: "test", version: "1.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<any[]> {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return await this.client.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}

async function run() {
  if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });

  const server = spawn("npx", ["tsx", "src/cli.ts", "serve", "--port", String(TEST_PORT), "--data", TEST_DATA, "--no-guardian", "--no-recorder"], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NERVE_LOG_LEVEL: "warn" },
  });

  // Wait for server
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try { const r = await httpPost("/node/list"); if (r.nodes) break; } catch {}
  }

  try {
    console.log("\n▸ MCP tools: nerve_command and nerve_capabilities");

    const mcp = new McpToolClient();
    await mcp.connect();

    // List tools
    const tools = await mcp.listTools();
    const toolNames = tools.map((t: any) => t.name);
    assert(toolNames.includes("nerve_command"), "nerve_command listed");
    assert(toolNames.includes("nerve_capabilities"), "nerve_capabilities listed");

    // Test nerve_capabilities
    const capResult = await mcp.callTool("nerve_capabilities");
    const capText = capResult.content?.[0]?.text;
    assert(!!capText, "capabilities returns text");
    const capData = JSON.parse(capText);
    assert(!!capData["ai-ear"], "capabilities includes ai-ear");
    assert(capData["ai-ear"]?.description === "实时音频采集与转录", "ai-ear description correct");
    assert(!capData["claude"], "capabilities excludes claude");

    await mcp.disconnect();
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log("Failures:", failures);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
