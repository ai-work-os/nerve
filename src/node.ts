import type { Transport } from "./transport.js";
import type { NodeStatus, PermissionLevel, NodeInfo, NodeUsage } from "./protocol.js";

export class NerveNode {
  readonly id: string;
  name: string;
  status: NodeStatus;
  capabilities: string[];
  permissions: PermissionLevel;
  transport: Transport;
  adapter?: string;
  cwd?: string;
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

  // In-memory buffer of ACP updates (for client reconnect replay)
  static readonly MAX_BUFFER_SIZE = 1000;
  updateBuffer: Record<string, unknown>[] = [];

  constructor(opts: {
    id: string;
    name: string;
    transport: Transport;
    capabilities?: string[];
    permissions?: PermissionLevel;
    adapter?: string;
    cwd?: string;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.transport = opts.transport;
    this.capabilities = opts.capabilities || [];
    this.permissions = opts.permissions || "member";
    this.adapter = opts.adapter;
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

  pushUpdate(params: Record<string, unknown>): void {
    this.updateBuffer.push(params);
    if (this.updateBuffer.length > NerveNode.MAX_BUFFER_SIZE) {
      this.updateBuffer.shift();
    }

    // Extract usage_update
    const update = params.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate === "usage_update") {
      this.usage = {
        tokenUsed: (update.used as number) || 0,
        tokenSize: (update.size as number) || 0,
        cost: typeof update.cost === "object" && update.cost !== null
          ? ((update.cost as Record<string, unknown>).amount as number) || 0
          : (update.cost as number) || 0,
        lastUpdated: Date.now(),
      };
    }
  }

  clearUpdateBuffer(): void {
    this.updateBuffer = [];
  }

  toInfo(): NodeInfo {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      capabilities: this.capabilities,
      permissions: this.permissions,
      transport: this.transport.type,
      adapter: this.adapter,
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
