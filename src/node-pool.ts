import { nanoid } from "nanoid";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { NerveNode } from "./node.js";
import { StdioTransport, WebSocketTransport, NullTransport } from "./transport.js";
import { AcpClient, type McpServerConfig } from "./acp-client.js";
import type { SessionNotification, SessionUpdate, ToolCall } from "@agentclientprotocol/sdk";
import { getAdapter } from "./adapter.js";
import * as log from "./logger.js";
import type { Store } from "./store.js";
import type { NodeStatus, PermissionLevel } from "./protocol.js";
import type { WebSocket } from "ws";

export type NodeEventHandler = (event: string, node: NerveNode, detail?: Record<string, unknown>) => void;

export interface TransportFactory {
  createStdio(): StdioTransport;
  createNull(): NullTransport;
}

export const defaultTransportFactory: TransportFactory = {
  createStdio: () => new StdioTransport(),
  createNull: () => new NullTransport(),
};

export class NodePool {
  private nodes = new Map<string, NerveNode>();
  private acpClients = new Map<string, AcpClient>();
  private nameIndex = new Map<string, string>(); // name → id
  private onEvent: NodeEventHandler;
  private store: Store;
  private transportFactory: TransportFactory;

  // Program node tracking
  private pendingPrograms = new Map<string, { nodeId: string; process: ChildProcess; timer: NodeJS.Timeout }>();
  private programProcesses = new Map<string, ChildProcess>(); // nodeId → process (for stop/shutdown)

  constructor(store: Store, onEvent: NodeEventHandler, transportFactory?: TransportFactory) {
    this.store = store;
    this.onEvent = onEvent;
    this.transportFactory = transportFactory || defaultTransportFactory;
  }

  /** Emit a node event (for use by server when mutating node state externally) */
  emitEvent(event: string, node: NerveNode, detail?: Record<string, unknown>): void {
    this.onEvent(event, node, detail);
  }

  /** Unified status change — all status mutations converge here.
   *  Guarantees: store sync + idempotent emit + activity reset on idle. */
  private _setNodeStatus(node: NerveNode, status: NodeStatus): void {
    const changed = node.status !== status;
    node.status = status;
    node.touch();

    // Activity auto-clear when transitioning to idle
    if (status === "idle") {
      node.activity = undefined;
    }

    // Always sync to store
    this.store.updateNodeStatus(node.id, status);

    // Only emit when status actually changed
    if (changed) {
      this.onEvent("node.statusChanged", node);
    }
  }

  /** Unified node cleanup — all cleanup paths converge here */
  private _cleanupNode(nodeId: string, opts?: {
    newStatus?: "stopped" | "error";
    removeFromPool?: boolean;
    exitCode?: number | null;
  }): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Idempotent guard: _cleaned prevents duplicate emit
    if (node._cleaned) {
      if (opts?.removeFromPool) {
        this.nodes.delete(nodeId);
        this.onEvent("node.removed", node);
      }
      return;
    }
    node._cleaned = true;

    // Status update (don't overwrite error with stopped)
    if (opts?.newStatus && node.status !== "error") {
      node.status = opts.newStatus;
      this.store.updateNodeStatus(nodeId, opts.newStatus);
    }

    // Name index cleanup
    this.nameIndex.delete(node.name);

    // Activity reset
    node.activity = undefined;

    // ACP client cleanup
    const client = this.acpClients.get(nodeId);
    if (client) {
      client.cleanup();
      this.acpClients.delete(nodeId);
    }

    // Program-related cleanup
    this.programProcesses.delete(nodeId);
    this.pendingPrograms.delete(node.name);

    // Update buffer
    node.clearUpdateBuffer();

    // Event notification
    this.onEvent("node.stopped", node, { exitCode: opts?.exitCode });

    // Optional: remove from pool
    if (opts?.removeFromPool) {
      this.nodes.delete(nodeId);
      this.onEvent("node.removed", node);
    }

    log.info(`_cleanupNode: ${node.name} (${nodeId}), status=${node.status}, removed=${!!opts?.removeFromPool}`);
  }

  get(id: string): NerveNode | undefined {
    return this.nodes.get(id);
  }

  getByName(name: string): NerveNode | undefined {
    const id = this.nameIndex.get(name);
    return id ? this.nodes.get(id) : undefined;
  }

  isNameTaken(name: string): boolean {
    return this.nameIndex.has(name);
  }

  getNameConflictInfo(name: string): string {
    const id = this.nameIndex.get(name);
    if (!id) return `name "${name}" already taken`;
    const node = this.nodes.get(id);
    if (!node) return `name "${name}" already taken`;
    const channels = [...node.channels];
    if (channels.length === 0) return `name "${name}" already taken (no channel)`;
    return `name "${name}" already taken (in channel ${channels.join(", ")})`;
  }

  listAll(): NerveNode[] {
    return [...this.nodes.values()];
  }

  /** Register a WebSocket node (nvim, browser, CLI tool) */
  registerWebSocket(ws: WebSocket, name: string, capabilities: string[], permissions: PermissionLevel): NerveNode {
    const id = nanoid(12);
    const transport = new WebSocketTransport(ws);
    const node = new NerveNode({ id, name, transport, capabilities, permissions });
    node.status = "idle";

    this.nodes.set(id, node);
    this.nameIndex.set(name, id);
    this.store.insertNode(id, name, "websocket", undefined, capabilities);
    this.store.updateNodeStatus(id, "idle");

    transport.onClose(() => {
      this.remove(id);
    });

    this.onEvent("node.registered", node);
    return node;
  }

  /** Spawn a Process Node synchronously (handshake runs in background) */
  spawnProcessSync(adapterName: string, name: string, cwd: string, serverPort: number): NerveNode {
    return this._spawnProcess(adapterName, name, cwd, serverPort);
  }

  /** Spawn a Process Node (CLI agent) */
  async spawnProcess(adapterName: string, name: string, cwd: string, serverPort: number): Promise<NerveNode> {
    return this._spawnProcess(adapterName, name, cwd, serverPort);
  }

  private _spawnProcess(adapterName: string, name: string, cwd: string, serverPort: number): NerveNode {
    const adapter = getAdapter(adapterName);
    if (!adapter) throw new Error(`unknown adapter: ${adapterName}`);

    // Route to program node path if adapter type is "program"
    if (adapter.type === "program") {
      return this.spawnProgramNode(adapterName, name, cwd, serverPort);
    }

    const id = nanoid(12);
    const transport = this.transportFactory.createStdio();
    const node = new NerveNode({
      id,
      name,
      transport,
      capabilities: adapter.capabilities,
      adapter: adapterName,
      cwd,
    });

    this.nodes.set(id, node);
    this.nameIndex.set(name, id);
    this.store.insertNode(id, name, "stdio", adapterName, adapter.capabilities, cwd);

    // Ensure .claude/settings.local.json exists with model preference (claude-agent-acp requires it)
    if (adapterName.startsWith("c") && adapterName !== "codex") {
      const settingsDir = join(cwd, ".claude");
      const settingsFile = join(settingsDir, "settings.local.json");
      if (!existsSync(settingsFile)) {
        mkdirSync(settingsDir, { recursive: true });
        const settings: Record<string, unknown> = {
          permissions: { allow: [], deny: [], ask: [] },
        };
        if (adapter.model) {
          settings.model = adapter.model;
        }
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      } else if (adapter.model) {
        // Ensure model is set in existing settings file
        try {
          const existing = JSON.parse(readFileSync(settingsFile, "utf8"));
          if (existing.model !== adapter.model) {
            existing.model = adapter.model;
            writeFileSync(settingsFile, JSON.stringify(existing, null, 2));
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Spawn the process
    transport.spawn({
      cmd: adapter.cmd,
      args: adapter.args,
      env: {
        ...adapter.env,
        NERVE_PORT: String(serverPort),
        NERVE_NODE_NAME: name,
        PATH: join(dirname(dirname(fileURLToPath(import.meta.url))), "bin") + ":" + (process.env.PATH || ""),
      },
      cwd,
    });

    this.store.updateNodeStatus(id, "connecting", undefined, transport.pid);

    transport.onClose((code) => {
      this._cleanupNode(id, { newStatus: "stopped", exitCode: code });
    });

    // Build MCP server config for nerve tools injection
    // Detect if running in dev mode (.ts) or compiled (.js)
    const selfDir = dirname(fileURLToPath(import.meta.url));
    const mcpScript = existsSync(join(selfDir, "nerve-mcp.ts"))
      ? join(selfDir, "nerve-mcp.ts")
      : join(selfDir, "nerve-mcp.js");
    const mcpServers: McpServerConfig[] = [{
      name: "nerve",
      command: existsSync(join(selfDir, "nerve-mcp.ts")) ? "npx" : process.execPath,
      args: existsSync(join(selfDir, "nerve-mcp.ts")) ? ["tsx", mcpScript] : [mcpScript],
      env: [
        { name: "NERVE_PORT", value: String(serverPort) },
        { name: "NERVE_NODE_NAME", value: name },
      ],
    }];
    log.info(`MCP inject: ${name} ← nerve (${mcpScript})`);

    // ACP handshake
    const client = new AcpClient({
      transport,
      authMethod: adapter.authMethod,
      cwd,
      mcpServers,
      onUpdate: (params: SessionNotification) => {
        node.pushUpdate(params);

        // 从 session/update 自动提取 activity，推送 statusChanged
        const update = params.update;
        if (update) {
          const newActivity = this.extractActivity(update as SessionUpdate);
          if (newActivity !== undefined) {
            const normalized = newActivity ?? undefined;
            if (normalized !== node.activity) {
              node.activity = normalized;
              node.touch();
              this.onEvent("node.statusChanged", node);
            }
          }
        }

        this.onEvent("node.update", node, params);
      },
      onReady: (sessionId) => {
        node.sessionId = sessionId;
        node.status = "idle";
        this.store.updateNodeStatus(id, "idle", sessionId);
        this.onEvent("node.ready", node);
        this.onEvent("node.statusChanged", node);
      },
      onError: (err) => {
        node.status = "error";
        this.store.updateNodeStatus(id, "error");
        this.onEvent("node.error", node, { error: err });
      },
    });

    this.acpClients.set(id, client);
    client.handshake(); // Don't await - let it run async

    this.onEvent("node.registered", node);
    return node;
  }

  /** Spawn a Program Node (connects back via WebSocket) */
  private spawnProgramNode(adapterName: string, name: string, cwd: string, serverPort: number): NerveNode {
    const adapter = getAdapter(adapterName)!;
    const id = nanoid(12);

    // Program nodes use nerve project root as cwd (adapter paths are relative to it)
    const nerveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    cwd = nerveRoot;

    // Create placeholder node with NullTransport (replaced when program connects via WS)
    const transport = this.transportFactory.createNull();
    const node = new NerveNode({
      id,
      name,
      transport,
      capabilities: adapter.capabilities,
      adapter: adapterName,
      cwd,
    });
    node.status = "connecting";

    this.nodes.set(id, node);
    this.nameIndex.set(name, id);
    this.store.insertNode(id, name, "websocket", adapterName, adapter.capabilities, cwd);

    // Spawn child process with env vars for WS reconnect
    const proc = spawnChild(adapter.cmd, adapter.args, {
      cwd,
      env: {
        ...process.env,
        ...adapter.env,
        NERVE_PORT: String(serverPort),
        NERVE_NODE_NAME: name,
        NERVE_SPAWNED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Log stderr for debugging
    proc.stderr?.on("data", (chunk: Buffer) => {
      log.debug(`program:${name} stderr: ${chunk.toString().trim()}`);
    });

    this.store.updateNodeStatus(id, "connecting", undefined, proc.pid);
    log.info(`program node spawned: ${name} (pid=${proc.pid}, adapter=${adapterName})`);

    // Connection timeout
    const timeout = adapter.connectTimeout ?? 10000;
    const timer = setTimeout(() => {
      if (node.status === "connecting") {
        log.warn(`program node timeout: ${name} did not connect within ${timeout}ms`);
        this._cleanupNode(id, { newStatus: "error" });
        this.onEvent("node.statusChanged", node);
        this.onEvent("node.error", node, { error: `program node did not connect within ${timeout}ms` });
        proc.kill("SIGTERM");
        // SIGKILL fallback after 5s if SIGTERM doesn't work
        const forceTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 5000);
        proc.on("exit", () => clearTimeout(forceTimer));
      }
    }, timeout);

    // Store in pending map (for WS reconnect matching)
    this.pendingPrograms.set(name, { nodeId: id, process: proc, timer });
    this.programProcesses.set(id, proc);

    // Process exit handler
    proc.on("exit", (code) => {
      clearTimeout(timer);
      this._cleanupNode(id, { newStatus: "stopped", removeFromPool: true, exitCode: code });
    });

    // Spawn error handler (e.g. cmd not found)
    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error(`program node spawn error: ${name} — ${err.message}`);
      this._cleanupNode(id, { newStatus: "error" });
      this.onEvent("node.error", node, { error: err.message });
      this.onEvent("node.statusChanged", node);
    });

    this.onEvent("node.registered", node);
    return node;
  }

  /** Claim a pending program node by name (called from server.ts on WS node.register) */
  claimPendingProgram(name: string): string | undefined {
    const pending = this.pendingPrograms.get(name);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingPrograms.delete(name);
    return pending.nodeId;
  }

  /** Check if a node is a program node (spawned process with WS transport) */
  isProgramNode(nodeId: string): boolean {
    return this.programProcesses.has(nodeId);
  }

  /** Track a process as a program node (used internally by spawnProgramNode, exposed for testing) */
  trackProgramProcess(nodeId: string, proc: ChildProcess): void {
    this.programProcesses.set(nodeId, proc);
  }

  /** Bind a WebSocket transport to a program node after WS reconnect */
  bindProgramTransport(nodeId: string, ws: WebSocket): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.transport = new WebSocketTransport(ws);
    node.status = "idle";
    this.store.updateNodeStatus(nodeId, "idle");

    log.info(`program node connected: ${node.name} (nodeId=${nodeId})`);
    this.onEvent("node.ready", node);
    this.onEvent("node.statusChanged", node);
  }

  private extractActivity(update: SessionUpdate | Record<string, unknown>): string | null | undefined {
    const kind = (update as any).sessionUpdate as string;
    switch (kind) {
      case "agent_thought_chunk": return "thinking";
      case "tool_call":           return `tool: ${(update as ToolCall & { sessionUpdate: string }).title || "..."}`;
      default:                    return undefined;
    }
  }

  /** Prompt a Process Node */
  async promptNode(nodeId: string, text: string, from?: { nodeId: string; name: string }, excludeWs?: WebSocket): Promise<{ stopReason?: string; error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) {
      log.warn(`promptNode: node ${nodeId} not found`);
      return { error: "node not found" };
    }

    log.info(`promptNode: ${node.name} (${nodeId}), text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    this._setNodeStatus(node, "busy");
    const userMsgParams: Record<string, unknown> = { update: { sessionUpdate: "user_message", content: { type: "text", text } }, from: from ? { nodeId: from.nodeId, name: from.name } : undefined };
    node.pushUpdate(userMsgParams);
    this.onEvent("node.update", node, excludeWs ? { ...userMsgParams, _excludeWs: excludeWs } : userMsgParams);

    let result: { stopReason?: string; error?: string };
    try {
      result = await client.prompt(text);
    } catch (err: any) {
      log.error(`promptNode: ${node.name} rejected: ${err.message}`);
      this._setNodeStatus(node, "idle");
      return { error: err.message };
    }

    this._setNodeStatus(node, "idle");
    log.info(`promptNode: ${node.name} done, stopReason=${result.stopReason || "none"}${result.error ? ", error=" + result.error : ""}`);

    return result;
  }

  /** Cancel a running prompt on a Process Node */
  async cancelNode(nodeId: string): Promise<{ error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) return { error: "node not found" };

    const result = await client.cancel();

    // Reset to idle (promptNode will also set idle when promise resolves/rejects)
    this._setNodeStatus(node, "idle");

    return result;
  }

  /** List sessions from a Process Node */
  async sessionList(nodeId: string): Promise<{ sessions?: Array<{ sessionId: string }>; error?: string }> {
    const client = this.acpClients.get(nodeId);
    if (!client) return { error: "node not found" };
    return client.sessionList();
  }

  /** Load/resume a session on a Process Node */
  async sessionLoad(nodeId: string, sessionId: string): Promise<{ error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) return { error: "node not found" };
    const result = await client.sessionLoad(sessionId);
    if (!result.error) {
      node.sessionId = sessionId;
      node.usage = undefined;
    }
    return result;
  }

  /** Clear session — creates a new session, discarding history */
  async sessionClear(nodeId: string): Promise<{ sessionId?: string; error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) return { error: "node not found" };
    const result = await client.sessionClear();
    if (!result.error && result.sessionId) {
      node.sessionId = result.sessionId;
      node.clearUpdateBuffer();
      node.usage = undefined;
      node.status = "idle";
      this.store.updateNodeStatus(nodeId, "idle", result.sessionId);
      this.onEvent("node.statusChanged", node);
    }
    return result;
  }

  /** Compact session — asks agent to compress its context window */
  async sessionCompact(nodeId: string): Promise<{ error?: string }> {
    const client = this.acpClients.get(nodeId);
    if (!client) return { error: "node not found" };
    return client.sessionCompact();
  }

  /** Reset session — clear + recovery prompt with summary file reference */
  async sessionReset(nodeId: string, expectedSessionId: string, summaryPath: string, selfReset = false, source = "unknown"): Promise<{ sessionId?: string; previousSessionId?: string; error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) {
      log.warn(`session reset rejected: nodeId=${nodeId}, reason=node not found, source=${source}`);
      return { error: "node not found" };
    }

    log.info(`session reset requested: ${node.name}, source=${source}, status=${node.status}, selfReset=${selfReset}, session=${expectedSessionId}`);

    if (node.status === "busy" && !selfReset) {
      log.warn(`session reset rejected: ${node.name}, reason=busy, source=${source}`);
      return { error: "node is busy" };
    }
    if (node.sessionId !== expectedSessionId) {
      log.warn(`session reset rejected: ${node.name}, reason=session mismatch, expected=${expectedSessionId}, actual=${node.sessionId}, source=${source}`);
      return { error: "session mismatch" };
    }
    if (node.resetInProgress) {
      log.warn(`session reset rejected: ${node.name}, reason=reset in progress, source=${source}`);
      return { error: "reset in progress" };
    }

    node.resetInProgress = true;
    try {
      const previousSessionId = node.sessionId;

      // ACP session/new (reuse sessionClear logic)
      const result = await client.sessionClear();
      if (result.error || !result.sessionId) {
        log.error(`session reset failed: ${node.name}, source=${source}, error=${result.error || "session clear failed"}`);
        return { error: result.error || "session clear failed" };
      }

      // Update node state
      node.sessionId = result.sessionId;
      node.clearUpdateBuffer();
      node.usage = undefined;
      node.prompted = false;
      node.status = "idle";
      this.store.updateNodeStatus(nodeId, "idle", result.sessionId);
      this.onEvent("node.statusChanged", node);

      // Build recovery prompt
      const channelId = [...node.channels][0] || "unknown";
      const resetPrompt = [
        `你是 ${node.name}，在频道 ${channelId} 中协作。`,
        `上一轮对话因上下文窗口接近上限已自动交接。`,
        `对话总结文件：${summaryPath}`,
        `请先读取总结文件，恢复工作上下文，然后继续未完成的任务。`,
        `当前工作目录：${node.cwd || process.cwd()}`,
      ].join("\n");

      log.info(`session reset: ${node.name} ${previousSessionId} → ${result.sessionId}, source=${source}, summary=${summaryPath}`);
      log.info(`recovery prompt: sending to ${node.name}, channel=${channelId}, summaryPath=${summaryPath}`);
      // Send recovery prompt (don't await — let agent process async)
      this.promptNode(nodeId, resetPrompt);

      return { sessionId: result.sessionId, previousSessionId };
    } finally {
      node.resetInProgress = false;
    }
  }

  /** Stop a Process Node. Returns a promise that resolves after graceful close (ACP nodes). */
  async stopNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    log.info(`stopNode: ${node.name} (${nodeId})`);

    // Check if this is a program node (has a tracked process)
    const proc = this.programProcesses.get(nodeId);
    if (proc) {
      // Program node: kill process, emit stopped event
      // Also close WS transport if connected
      if (node.transport.alive) node.transport.close();
      proc.kill("SIGTERM");
      // Force kill after 5s
      const forceTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
      proc.on("exit", () => clearTimeout(forceTimer));
      // Note: exit handler in spawnProgramNode will set status=stopped and emit node.stopped
      return;
    }

    // ACP node: closeSession first, then unified cleanup
    const client = this.acpClients.get(nodeId);
    if (client) {
      await client.closeSession();
    }

    this._cleanupNode(nodeId, { newStatus: "stopped" });
    node.transport.close();
  }

  /** Remove a node from the pool */
  remove(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    log.info(`remove: ${node.name} (${nodeId})`);
    this._cleanupNode(nodeId, { removeFromPool: true });
  }

  /** Shutdown all nodes */
  async shutdown(): Promise<void> {
    for (const [id, node] of this.nodes) {
      if (node.isProcess || this.programProcesses.has(id)) {
        this.stopNode(id);
      } else {
        node.transport.close();
      }
    }
    // Clear pending program timers
    for (const [, pending] of this.pendingPrograms) {
      clearTimeout(pending.timer);
      pending.process.kill("SIGTERM");
    }
    this.pendingPrograms.clear();
    // Wait for process nodes to exit
    await new Promise(r => setTimeout(r, 2000));
  }
}
