// JSON-RPC 2.0 types
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg) && !("method" in msg);
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

let _nextId = 0;
export function nextId(): number {
  return ++_nextId;
}

export function encodeRequest(id: number | string, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export function encodeResponse(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function encodeError(id: number | string, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function encodeNotification(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

// Line buffer for parsing newline-delimited JSON from stdio
export class LineBuffer {
  private buf = "";

  feed(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) lines.push(line);
    }
    return lines;
  }
}

// Node types
export type NodeStatus = "connecting" | "idle" | "busy" | "error" | "stopped" | "offline";
export type PermissionLevel = "operator" | "member" | "observer";

export interface NodeUsage {
  tokenUsed: number;
  tokenSize: number;
  cost: number;
  lastUpdated: number;
}

/** Per-service status surfaced by service-supervisor when exposed as a
 *  local node. Mirrors ServiceSupervisor.ProcessStatus so callers (and
 *  watchdog) don't depend on the service/ module from the transport layer. */
export interface SupervisedServiceStatus {
  name: string;
  pid?: number;
  state: "running" | "restarting" | "stopped";
  restarts: number;
  restartHistory: number[];
}

export interface HealthContract {
  /** Liveness 检查类型。process = 检查 pid 是否还在；connection = 检查 WS 是否在线；none = 不检查。默认 process。 */
  liveness?: "process" | "connection" | "none";
  /** 多久没活动算异常（毫秒）。"none" = 不检查（事件驱动节点用）。检查依据：NodeInfo.lastActiveAt。 */
  maxIdleMs?: number | "none";
  /** 进程内存上限（MB）。未设置 = 不检查。 */
  maxMemoryMB?: number;
}

export interface NodeInfo {
  id: string;
  name: string;
  status: NodeStatus;
  capabilities: string[];
  permissions: PermissionLevel;
  transport: "stdio" | "websocket" | "local";
  pid?: number;
  adapter?: string;
  model?: string;
  source?: string;
  activity?: string;
  cwd?: string;
  sessionId?: string;
  channels: string[];
  createdAt: number;
  lastActiveAt: number;
  usage?: NodeUsage;
  commands?: Record<string, { description: string; args?: Record<string, string> }>;
  events?: string[];
  health?: HealthContract;
  /** Per-service state for nodes that wrap a process supervisor (today: the
   *  service-supervisor local node). watchdog reads this to detect restart
   *  loops via restart-loop-detector. */
  supervised?: SupervisedServiceStatus[];
}

export interface ChannelInfo {
  id: string;
  name?: string;
  cwd: string;
  nodes: Record<string, string>; // nodeName → nodeId
  createdAt: number;
}

export interface MessageInfo {
  id: string;
  channelId: string;
  from: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// In-memory DM message (per-node) — assembled from streaming events,
// replayed via message_snapshot on subscribe.
export type MessageRole = "user" | "agent" | "system";

export type MessageAction =
  | {
      type: "open_dm";
      nodeId: string;
      nodeName: string;
    };

export interface Message {
  id: string;        // nerve-generated, stable within one nerve process lifetime
  nodeId: string;
  role: MessageRole;
  sender: string;    // display name (e.g., "claude", "renjinxi")
  text: string;      // full assembled text
  ts: number;        // unix ms
  action?: MessageAction;
}
