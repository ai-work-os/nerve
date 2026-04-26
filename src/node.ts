import type { Transport } from "./transport.js";
import type { NodeStatus, PermissionLevel, NodeInfo, NodeUsage, Message } from "./protocol.js";
import type { SessionNotification, UsageUpdate, Cost } from "@agentclientprotocol/sdk";
import { getContextWindow } from "./model-registry.js";
import { getAdapter } from "./adapter.js";
import * as log from "./logger.js";

// In-flight assembler for streaming agent response.
// Created on agent_message_start (or lazily on first chunk), finalized at prompt end.
export interface InFlightMessage {
  id: string;
  text: string;
}

export class NerveNode {
  readonly id: string;
  name: string;
  status: NodeStatus;
  capabilities: string[];
  permissions: PermissionLevel;
  transport: Transport;
  adapter?: string;
  model?: string;
  cwd?: string;
  source?: string;  // client type identifier (e.g., "android", "tui", "web")
  sessionId?: string;
  channels = new Set<string>();
  activity?: string;
  createdAt: number;
  lastActiveAt: number;
  systemPrompt?: string;
  prompted = false;
  usage?: NodeUsage;
  commands?: Record<string, { description: string; args?: Record<string, string> }>;
  events?: string[];

  // For stdio nodes: prompt generation counter (prevent stale callbacks)
  promptGen = 0;

  // Mutex for session reset — prevents concurrent resets
  resetInProgress = false;

  // Cleanup guard — prevents duplicate node.stopped emit
  _cleaned = false;

  // Flag: set by stopNode() before killing program node process
  _manualStop = false;

  // DM capture: accumulate AI response text during promptNode() for dm.response event
  _dmResponseBuffer?: string;

  // Track last reported context size for change detection
  lastReportedSize?: number;

  // In-memory store of assembled Messages (for client reconnect replay).
  // Not persisted; cleared on node cleanup / session clear / session reset.
  messageStore: Message[] = [];

  // In-flight agent message being assembled from chunk stream.
  // Created on agent_message_start (or first chunk), finalized at prompt end.
  inFlightAgent: InFlightMessage | null = null;

  constructor(opts: {
    id: string;
    name: string;
    transport: Transport;
    capabilities?: string[];
    permissions?: PermissionLevel;
    adapter?: string;
    model?: string;
    cwd?: string;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.transport = opts.transport;
    this.capabilities = opts.capabilities || [];
    this.permissions = opts.permissions || "member";
    this.adapter = opts.adapter;
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.status = "connecting";
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
  }

  get isProcess(): boolean {
    return this.transport.type === "stdio";
  }

  get isWebSocket(): boolean {
    return this.transport.type === "websocket";
  }

  touch(): void {
    this.lastActiveAt = Date.now();
  }

  get effectiveModel(): string | undefined {
    const adapterModel = this.adapter ? getAdapter(this.adapter)?.model : undefined;
    return this.model || adapterModel;
  }

  // Called on every ACP SessionNotification to normalize usage_update side-effects.
  // No longer writes to a buffer — the messageStore is populated via explicit
  // assembler operations in NodePool.
  observeUpdate(params: SessionNotification | Record<string, unknown>): void {
    log.debug(`[${this.name}] observeUpdate: sessionUpdate=${(params as any)?.update?.sessionUpdate}`);

    const update = (params as SessionNotification).update as (UsageUpdate & { sessionUpdate: string }) | undefined;
    if (update?.sessionUpdate === "usage_update") {
      const effectiveModel = this.effectiveModel;
      const actualSize = getContextWindow(effectiveModel);
      log.debug(`[${this.name}] usage_update wire: used=${update.used} size=${update.size} actualSize=${actualSize} model=${effectiveModel} cost=${JSON.stringify(update.cost)}`);
      const cost = update.cost as Cost | null | undefined;
      const newSize = actualSize ?? update.size ?? 0;
      (update as any).size = newSize;
      if (this.lastReportedSize !== undefined && this.lastReportedSize !== newSize) {
        log.warn(`[${this.name}] context size changed: ${this.lastReportedSize} → ${newSize}`);
      }
      this.lastReportedSize = newSize;
      this.usage = {
        tokenUsed: update.used || 0,
        tokenSize: newSize,
        cost: cost?.amount || 0,
        lastUpdated: Date.now(),
      };
    }
  }

  /** Append an assembled Message to the store. */
  appendMessage(msg: Message): void {
    this.messageStore.push(msg);
    log.debug(`[${this.name}] appendMessage: id=${msg.id} role=${msg.role} len=${msg.text.length} total=${this.messageStore.length}`);
  }

  /** Clear messageStore and in-flight assembler. Called on cleanup / session clear / session reset. */
  clearMessageStore(): void {
    this.messageStore = [];
    this.inFlightAgent = null;
  }

  toInfo(): NodeInfo {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      capabilities: this.capabilities,
      permissions: this.permissions,
      transport: this.transport.type,
      pid: this.transport.type === "stdio" ? (this.transport as any).pid : undefined,
      adapter: this.adapter,
      model: this.effectiveModel,
      source: this.source,
      activity: this.activity,
      channels: [...this.channels],
      cwd: this.cwd,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      usage: this.usage,
      commands: this.commands,
      events: this.events,
    };
  }
}
