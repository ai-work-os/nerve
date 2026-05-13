import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import type { StdioTransport } from "../transport/transport.js";
import type { JsonRpcMessage } from "../transport/protocol.js";
import {
  ClientSideConnection,
  RequestError,
  type Client,
  type Stream,
  type AnyMessage,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type ListSessionsResponse,
  type PromptRequest,
  type PromptResponse,
  type ContentBlock,
  type SessionNotification,
  type McpServerStdio,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import * as log from "../infra/logger.js";
import { child as childLogger } from "../infra/logger.js";

const acpLog = childLogger({ module: "agent:acp" });

/** Re-export McpServerStdio as McpServerConfig for backward compatibility */
export type McpServerConfig = McpServerStdio;

export type PromptAttachment = Extract<ContentBlock, { type: "image" }>;

export interface AcpClientOptions {
  transport: StdioTransport;
  authMethod?: string;
  cwd: string;
  mcpServers?: McpServerConfig[];
  onUpdate?: (params: SessionNotification) => void;
  onReady?: (sessionId: string) => void;
  onError?: (err: string) => void;
  /** Prompt timeout in ms (default: 300000) */
  promptTimeout?: number;
}

/**
 * Bridge StdioTransport (callback-based) to SDK Stream (Web Streams API).
 *
 * session/update notifications are intercepted and forwarded directly to onUpdate
 * to avoid SDK Zod validation rejecting non-standard update types (e.g. custom
 * sessionUpdate values from agents). All other messages pass through the SDK normally.
 */
function transportToStream(
  transport: StdioTransport,
  onUpdate?: (params: SessionNotification) => void,
): { stream: Stream; closeReadable: () => void } {
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;
      transport.onMessage((msg: JsonRpcMessage) => {
        // Intercept session/update notifications — handle directly to bypass SDK Zod validation
        const m = msg as any;
        if (m.method === "session/update" && !("id" in m)) {
          log.debug(`[ACP] intercepted session/update: ${JSON.stringify(m.params).slice(0, 200)}`);
          acpLog.boundary("in", "acp", { method: "session/update" });
          onUpdate?.(m.params as SessionNotification);
          return;
        }
        controller.enqueue(msg as unknown as AnyMessage);
      });
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      transport.send(msg as unknown as JsonRpcMessage);
    },
  });

  return {
    stream: { readable, writable },
    closeReadable: () => {
      try { readableController?.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * ACP Client handles the protocol handshake and ongoing communication
 * with a CLI agent over StdioTransport.
 *
 * Uses @agentclientprotocol/sdk ClientSideConnection for JSON-RPC transport.
 */
export class AcpClient {
  private connection: ClientSideConnection;
  private closeReadable: () => void;
  private authMethod?: string;
  private cwd: string;
  private mcpServers: McpServerConfig[];
  private onReady?: (sessionId: string) => void;
  private onError?: (err: string) => void;
  private promptTimeout: number;

  sessionId?: string;
  agentName?: string;
  agentCapabilities?: Record<string, unknown>;

  // Track whether a prompt is in flight (for cancel guard)
  private promptInFlight = false;

  // Terminal management for reverse requests
  private terminals = new Map<string, { process: ChildProcess; output: string }>();

  constructor(opts: AcpClientOptions) {
    this.authMethod = opts.authMethod;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers ?? [];
    this.onReady = opts.onReady;
    this.onError = opts.onError;
    this.promptTimeout = opts.promptTimeout ?? 1800000;

    const { stream, closeReadable } = transportToStream(opts.transport, opts.onUpdate);
    this.closeReadable = closeReadable;

    // Create ClientSideConnection with our Client implementation
    this.connection = new ClientSideConnection(
      (_agent) => this.createClientHandler(),
      stream,
    );
  }

  /** Build the Client interface implementation for handling reverse requests */
  private createClientHandler(): Client {
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // Auto-approve: pick allow_once/allow_always from options
        const options = params.options || [];
        const allowKinds: PermissionOptionKind[] = ["allow_once", "allow_always"];
        const allowOption = options.find(o => allowKinds.includes(o.kind));
        const optionId = allowOption?.optionId || "allow";
        return { outcome: { outcome: "selected", optionId } };
      },

      // session/update is intercepted in transportToStream before reaching the SDK
      sessionUpdate: async (): Promise<void> => {},

      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        try {
          const filePath = params.path;
          if (!filePath) {
            throw RequestError.invalidParams(undefined, "missing path");
          }
          const content = readFileSync(filePath, "utf8");
          const lines = content.split("\n");
          const line = params.line || 0;
          const limit = params.limit || lines.length;
          const sliced = lines.slice(line, line + limit).join("\n");
          return { content: sliced };
        } catch (err) {
          if (err instanceof RequestError) throw err;
          // File not found — return empty content (match nvim behavior)
          return { content: "" };
        }
      },

      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        try {
          mkdirSync(dirname(params.path), { recursive: true });
          writeFileSync(params.path, params.content, "utf8");
          return {};
        } catch (err) {
          throw RequestError.internalError(undefined, `write failed: ${err}`);
        }
      },

      createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
        const termId = nanoid(8);
        const cmd = params.command || "/bin/sh";
        const args = params.args || [];
        const proc = spawn(cmd, args, {
          cwd: this.cwd,
          env: process.env,
          shell: true,
        });
        const term = { process: proc, output: "" };
        this.terminals.set(termId, term);
        proc.stdout?.on("data", (d: Buffer) => { term.output += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { term.output += d.toString(); });
        return { terminalId: termId };
      },

      terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw RequestError.internalError(undefined, "terminal not found");
        return { output: term.output, truncated: false };
      },

      waitForTerminalExit: async (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw RequestError.internalError(undefined, "terminal not found");
        if (term.process.exitCode !== null) {
          return { exitCode: term.process.exitCode };
        }
        return new Promise((resolve) => {
          term.process.once("exit", (code) => {
            resolve({ exitCode: code ?? 1 });
          });
        });
      },

      killTerminal: async (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw RequestError.internalError(undefined, "terminal not found");
        term.process.kill("SIGTERM");
        return {};
      },

      releaseTerminal: async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
        const term = this.terminals.get(params.terminalId);
        if (!term) throw RequestError.internalError(undefined, "terminal not found");
        term.process.kill("SIGTERM");
        this.terminals.delete(params.terminalId);
        return {};
      },
    };
  }

  /** Start the ACP handshake sequence */
  async handshake(): Promise<void> {
    try {
      // Step 1: initialize
      acpLog.boundary("out", "acp", { method: "initialize" });
      const initResult = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "nerve", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      this.agentName = initResult.agentInfo?.name;
      this.agentCapabilities = (initResult.agentCapabilities ?? (initResult as any).capabilities) as Record<string, unknown>;
      log.info(`acp:init agent=${this.agentName}`);

      // Step 2: authenticate (optional)
      if (this.authMethod) {
        acpLog.boundary("out", "acp", { method: "authenticate" });
        await this.connection.authenticate({ methodId: this.authMethod });
      }

      // Step 3: session/new (with retry)
      acpLog.boundary("out", "acp", { method: "session/new" });
      const sessionResult = await this.newSessionWithRetry(2);

      this.sessionId = sessionResult.sessionId;
      this.onReady?.(this.sessionId);
    } catch (err) {
      this.onError?.(`handshake failed: ${err}`);
    }
  }

  private async newSessionWithRetry(retries: number): Promise<NewSessionResponse> {
    const params: NewSessionRequest = { cwd: this.cwd, mcpServers: this.mcpServers };
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.connection.newSession(params);
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error("unreachable");
  }

  /** List all sessions from the agent */
  async sessionList(): Promise<{ sessions?: ListSessionsResponse["sessions"]; error?: string }> {
    try {
      const result = await this.connection.listSessions({});
      return { sessions: result.sessions };
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Load/resume a previous session (agent pushes history via session/update) */
  async sessionLoad(sessionId: string): Promise<{ error?: string }> {
    try {
      await this.connection.loadSession({ sessionId, cwd: this.cwd, mcpServers: this.mcpServers });
      this.sessionId = sessionId;
      return {};
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Clear session — creates a new session on the same agent, discarding history */
  async sessionClear(): Promise<{ sessionId?: string; error?: string }> {
    try {
      const result = await this.connection.newSession({ cwd: this.cwd, mcpServers: this.mcpServers });
      this.sessionId = result.sessionId;
      return { sessionId: this.sessionId };
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Compact session — asks the agent to compress its context window */
  async sessionCompact(): Promise<{ error?: string }> {
    if (!this.sessionId) return { error: "no session" };
    try {
      await this.connection.extMethod("session/compact", {
        sessionId: this.sessionId,
      });
      return {};
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Send a prompt to the agent */
  async prompt(text: string, attachments: PromptAttachment[] = []): Promise<{ stopReason?: string; error?: string }> {
    if (!this.sessionId) {
      return { error: "no session" };
    }

    try {
      this.promptInFlight = true;
      acpLog.boundary("out", "acp", { method: "session/prompt", sessionId: this.sessionId });

      const result = await Promise.race([
        this.connection.prompt({
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }, ...attachments],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`session/prompt timeout after ${this.promptTimeout}ms`)), this.promptTimeout)
        ),
      ]);

      return { stopReason: result.stopReason, ...((result as any).error ? { error: String((result as any).error) } : {}) };
    } catch (err) {
      return { error: String(err) };
    } finally {
      this.promptInFlight = false;
    }
  }

  /** Cancel the current prompt (notification, not request — ACP spec) */
  async cancel(): Promise<{ error?: string }> {
    if (!this.sessionId) return { error: "no session" };
    if (!this.promptInFlight) return { error: "no active prompt" };

    acpLog.boundary("out", "acp", { method: "session/cancel", sessionId: this.sessionId });
    await this.connection.cancel({ sessionId: this.sessionId });
    return {};
  }

  /** Send session/close to agent if supported, with 5s timeout. Never throws. */
  async closeSession(): Promise<void> {
    if (!this.sessionId) {
      log.info("closeSession: no session, skip");
      return;
    }

    const sessionCaps = (this.agentCapabilities as any)?.sessionCapabilities;
    if (!sessionCaps?.close) {
      log.info("closeSession: session.close not supported, skip");
      return;
    }

    log.info(`closeSession: sending session/close for ${this.sessionId}`);
    try {
      await Promise.race([
        this.connection.unstable_closeSession({ sessionId: this.sessionId }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      log.info("closeSession: completed");
    } catch (err) {
      log.warn(`closeSession timeout or error: ${err} — continuing with cleanup`);
    }
  }

  cleanup(): void {
    for (const [, term] of this.terminals) {
      term.process.kill("SIGTERM");
    }
    this.terminals.clear();
    this.closeReadable();
  }
}
