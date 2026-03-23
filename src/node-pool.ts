import { nanoid } from "nanoid";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NerveNode } from "./node.js";
import { StdioTransport, WebSocketTransport } from "./transport.js";
import { AcpClient, type McpServerConfig } from "./acp-client.js";
import { getAdapter } from "./adapter.js";
import * as log from "./logger.js";
import type { Store } from "./store.js";
import type { PermissionLevel } from "./protocol.js";
import type { WebSocket } from "ws";

export type NodeEventHandler = (event: string, node: NerveNode, detail?: Record<string, unknown>) => void;

export class NodePool {
  private nodes = new Map<string, NerveNode>();
  private acpClients = new Map<string, AcpClient>();
  private nameIndex = new Map<string, string>(); // name → id
  private onEvent: NodeEventHandler;
  private store: Store;

  constructor(store: Store, onEvent: NodeEventHandler) {
    this.store = store;
    this.onEvent = onEvent;
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

    const id = nanoid(12);
    const transport = new StdioTransport();
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

    // Ensure .claude/settings.local.json exists (claude-agent-acp requires it)
    if (adapterName.startsWith("c") && adapterName !== "codex") {
      const settingsDir = join(cwd, ".claude");
      const settingsFile = join(settingsDir, "settings.local.json");
      if (!existsSync(settingsFile)) {
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(settingsFile, JSON.stringify({
          permissions: { allow: [], deny: [], ask: [] },
        }, null, 2));
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
      node.status = "stopped";
      this.store.updateNodeStatus(id, "stopped");
      this.onEvent("node.stopped", node, { exitCode: code });
      // Clean up ACP client
      const client = this.acpClients.get(id);
      if (client) {
        client.cleanup();
        this.acpClients.delete(id);
      }
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
      onUpdate: (params) => {
        node.pushUpdate(params);
        this.onEvent("node.update", node, params);
      },
      onReady: (sessionId) => {
        node.sessionId = sessionId;
        node.status = "idle";
        this.store.updateNodeStatus(id, "idle", sessionId);
        this.onEvent("node.ready", node);
      },
      onError: (err) => {
        node.status = "error";
        this.store.updateNodeStatus(id, "error");
        this.onEvent("node.error", node, { error: err });
      },
    });

    this.acpClients.set(id, client);
    client.handshake(); // Don't await - let it run async

    return node;
  }

  /** Prompt a Process Node */
  async promptNode(nodeId: string, text: string): Promise<{ stopReason?: string; error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) return { error: "node not found" };

    node.status = "busy";
    node.touch();
    node.pushUpdate({ update: { sessionUpdate: "user_message", content: { type: "text", text } } });
    this.onEvent("node.statusChanged", node);

    const result = await client.prompt(text);

    node.status = "idle";
    node.touch();
    this.onEvent("node.statusChanged", node);

    return result;
  }

  /** Cancel a running prompt on a Process Node */
  async cancelNode(nodeId: string): Promise<{ error?: string }> {
    const client = this.acpClients.get(nodeId);
    const node = this.nodes.get(nodeId);
    if (!client || !node) return { error: "node not found" };

    const result = await client.cancel();

    // Reset to idle (promptNode will also set idle when promise resolves/rejects)
    node.status = "idle";
    node.touch();
    this.onEvent("node.statusChanged", node);

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
      this.store.updateNodeStatus(nodeId, "idle", result.sessionId);
    }
    return result;
  }

  /** Compact session — asks agent to compress its context window */
  async sessionCompact(nodeId: string): Promise<{ error?: string }> {
    const client = this.acpClients.get(nodeId);
    if (!client) return { error: "node not found" };
    return client.sessionCompact();
  }

  /** Stop a Process Node */
  stopNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const client = this.acpClients.get(nodeId);
    if (client) {
      client.cleanup();
      this.acpClients.delete(nodeId);
    }

    node.transport.close();
    // Node removal happens in onClose handler
  }

  /** Remove a node from the pool */
  remove(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.clearUpdateBuffer();
    this.nodes.delete(nodeId);
    this.nameIndex.delete(node.name);

    this.onEvent("node.removed", node);
  }

  /** Shutdown all nodes */
  async shutdown(): Promise<void> {
    for (const [id, node] of this.nodes) {
      if (node.isProcess) {
        this.stopNode(id);
      } else {
        node.transport.close();
      }
    }
    // Wait for process nodes to exit
    await new Promise(r => setTimeout(r, 2000));
  }
}
