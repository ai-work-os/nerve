import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isRequest,
  isResponse,
  isNotification,
  nextId,
  encodeRequest,
  encodeResponse,
  encodeError,
  LineBuffer,
} from "./protocol.js";
import type { StdioTransport } from "./transport.js";

type PendingCallback = (result: unknown, error?: { code: number; message: string }) => void;

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpClientOptions {
  transport: StdioTransport;
  authMethod?: string;
  cwd: string;
  mcpServers?: McpServerConfig[];
  onUpdate?: (params: Record<string, unknown>) => void;
  onReady?: (sessionId: string) => void;
  onError?: (err: string) => void;
}

/**
 * ACP Client handles the protocol handshake and ongoing communication
 * with a CLI agent over StdioTransport.
 */
export class AcpClient {
  private transport: StdioTransport;
  private pending = new Map<number | string, PendingCallback>();
  private authMethod?: string;
  private cwd: string;
  private mcpServers: McpServerConfig[];
  private onUpdate?: (params: Record<string, unknown>) => void;
  private onReady?: (sessionId: string) => void;
  private onError?: (err: string) => void;

  sessionId?: string;
  agentName?: string;
  agentCapabilities?: Record<string, unknown>;

  // Track current prompt for cancel support
  private currentPromptId?: number | string;
  private currentPromptReject?: (err: Error) => void;

  // Terminal management for reverse requests
  private terminals = new Map<string, { process: ChildProcess; output: string }>();

  constructor(opts: AcpClientOptions) {
    this.transport = opts.transport;
    this.authMethod = opts.authMethod;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers ?? [];
    this.onUpdate = opts.onUpdate;
    this.onReady = opts.onReady;
    this.onError = opts.onError;

    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  /** Start the ACP handshake sequence */
  async handshake(): Promise<void> {
    try {
      // Step 1: initialize
      const initResult = await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "nerve", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }, 15000) as Record<string, unknown>;

      this.agentName = (initResult.agentInfo as any)?.name;
      this.agentCapabilities = (initResult.agentCapabilities ?? initResult.capabilities) as Record<string, unknown>;

      // Step 2: authenticate (optional)
      if (this.authMethod) {
        await this.request("authenticate", {
          authMethod: this.authMethod,
        }, 15000);
      }

      // Step 3: session/new
      const sessionResult = await this.requestWithRetry("session/new", {
        cwd: this.cwd,
        mcpServers: this.mcpServers,
      }, 30000, 2) as Record<string, unknown>;

      this.sessionId = sessionResult.sessionId as string;
      this.onReady?.(this.sessionId);
    } catch (err) {
      this.onError?.(`handshake failed: ${err}`);
    }
  }

  /** List all sessions from the agent */
  async sessionList(): Promise<{ sessions?: Array<{ sessionId: string; [key: string]: unknown }>; error?: string }> {
    try {
      const result = await this.request("session/list", {}, 15000) as Record<string, unknown>;
      return { sessions: result.sessions as any[] };
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Load/resume a previous session (agent pushes history via session/update) */
  async sessionLoad(sessionId: string): Promise<{ error?: string }> {
    try {
      await this.request("session/load", { sessionId }, 30000);
      this.sessionId = sessionId;
      return {};
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Send a prompt to the agent */
  async prompt(text: string): Promise<{ stopReason?: string; error?: string }> {
    if (!this.sessionId) {
      return { error: "no session" };
    }

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = nextId();
        this.currentPromptId = id;
        this.currentPromptReject = reject;

        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.currentPromptId = undefined;
          this.currentPromptReject = undefined;
          reject(new Error("session/prompt timeout after 300000ms"));
        }, 300000);

        this.pending.set(id, (result, error) => {
          clearTimeout(timer);
          this.currentPromptId = undefined;
          this.currentPromptReject = undefined;
          if (error) reject(new Error(`session/prompt: ${error.message}`));
          else resolve(result);
        });

        this.transport.send({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: {
            sessionId: this.sessionId,
            prompt: [{ type: "text", text }],
          },
        } as JsonRpcMessage);
      }) as Record<string, unknown>;

      return { stopReason: result.stopReason as string };
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Cancel the current prompt (notification, not request — ACP spec) */
  async cancel(): Promise<{ error?: string }> {
    if (!this.sessionId) return { error: "no session" };
    if (!this.currentPromptId) return { error: "no active prompt" };

    // session/cancel is a NOTIFICATION (no id), not a request.
    // Agent responds by resolving the pending session/prompt with stopReason: "cancelled".
    this.transport.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    } as JsonRpcMessage);

    return {};
  }

  private async request(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, (result, error) => {
        clearTimeout(timer);
        if (error) reject(new Error(`${method}: ${error.message}`));
        else resolve(result);
      });

      this.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      } as JsonRpcMessage);
    });
  }

  private async requestWithRetry(method: string, params: Record<string, unknown>, timeout: number, retries: number): Promise<unknown> {
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.request(method, params, timeout);
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error("unreachable");
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg.result, msg.error as any);
      }
      return;
    }

    if (isNotification(msg)) {
      if (msg.method === "session/update") {
        this.onUpdate?.(msg.params || {});
      }
      return;
    }

    if (isRequest(msg)) {
      this.handleReverseRequest(msg as JsonRpcRequest);
      return;
    }
  }

  private handleReverseRequest(req: JsonRpcRequest): void {
    const { method, params, id } = req;
    const p = (params || {}) as Record<string, unknown>;

    switch (method) {
      case "session/request_permission": {
        // Auto-approve: pick allow_once/allow_always from options, match ACP spec format
        const options = (p.options as Array<{ kind: string; optionId: string }>) || [];
        const allowOption = options.find(o => o.kind === "allow_once" || o.kind === "allow_always");
        const optionId = allowOption?.optionId || "allow";
        this.sendResponse(id, { outcome: { outcome: "selected", optionId } });
        break;
      }

      case "fs/read_text_file": {
        try {
          const filePath = (p.path || p.filePath) as string;
          if (!filePath) {
            this.sendError(id, -32602, "missing path");
            break;
          }
          const content = readFileSync(filePath, "utf8");
          const lines = content.split("\n");
          const line = (p.line as number) || 0;
          const limit = (p.limit as number) || lines.length;
          const sliced = lines.slice(line, line + limit).join("\n");
          this.sendResponse(id, { content: sliced });
        } catch (err) {
          // File not found — return empty content (match nvim behavior)
          this.sendResponse(id, { content: "" });
        }
        break;
      }

      case "fs/write_text_file": {
        try {
          const filePath = (p.path || p.filePath) as string;
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, p.content as string, "utf8");
          this.sendResponse(id, {});
        } catch (err) {
          this.sendError(id, -32000, `write failed: ${err}`);
        }
        break;
      }

      case "terminal/create": {
        const termId = nanoid(8);
        const cmd = (p.command as string) || "/bin/sh";
        const args = (p.args as string[]) || [];
        const proc = spawn(cmd, args, {
          cwd: this.cwd,
          env: process.env,
          shell: true,
        });
        let output = "";
        proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
        this.terminals.set(termId, { process: proc, output: "" });
        // Store reference to track output
        const term = this.terminals.get(termId)!;
        proc.stdout?.on("data", () => { term.output = output; });
        proc.stderr?.on("data", () => { term.output = output; });
        this.sendResponse(id, { terminalId: termId });
        break;
      }

      case "terminal/output": {
        const termId = p.terminalId as string;
        const term = this.terminals.get(termId);
        if (term) {
          this.sendResponse(id, { output: term.output });
        } else {
          this.sendError(id, -32000, "terminal not found");
        }
        break;
      }

      case "terminal/wait_for_exit": {
        const termId = p.terminalId as string;
        const term = this.terminals.get(termId);
        if (term) {
          if (term.process.exitCode !== null) {
            this.sendResponse(id, { exitCode: term.process.exitCode });
          } else {
            term.process.once("exit", (code) => {
              this.sendResponse(id, { exitCode: code ?? 1 });
            });
          }
        } else {
          this.sendError(id, -32000, "terminal not found");
        }
        break;
      }

      case "terminal/kill": {
        const termId = p.terminalId as string;
        const term = this.terminals.get(termId);
        if (term) {
          term.process.kill("SIGTERM");
          this.sendResponse(id, {});
        } else {
          this.sendError(id, -32000, "terminal not found");
        }
        break;
      }

      case "terminal/release": {
        const termId = p.terminalId as string;
        const term = this.terminals.get(termId);
        if (term) {
          term.process.kill("SIGTERM");
          this.terminals.delete(termId);
          this.sendResponse(id, {});
        } else {
          this.sendError(id, -32000, "terminal not found");
        }
        break;
      }

      default:
        this.sendError(id, -32601, `method not found: ${method}`);
    }
  }

  private sendResponse(id: number | string, result: unknown): void {
    this.transport.send({
      jsonrpc: "2.0",
      id,
      result,
    } as JsonRpcMessage);
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.transport.send({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    } as JsonRpcMessage);
  }

  cleanup(): void {
    for (const [, term] of this.terminals) {
      term.process.kill("SIGTERM");
    }
    this.terminals.clear();
    this.pending.clear();
  }
}
