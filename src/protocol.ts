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
export type NodeStatus = "connecting" | "idle" | "busy" | "error" | "stopped";
export type PermissionLevel = "operator" | "member" | "observer";

export interface NodeUsage {
  tokenUsed: number;
  tokenSize: number;
  cost: number;
  lastUpdated: number;
}

export interface NodeInfo {
  id: string;
  name: string;
  status: NodeStatus;
  capabilities: string[];
  permissions: PermissionLevel;
  transport: "stdio" | "websocket";
  adapter?: string;
  activity?: string;
  cwd?: string;
  sessionId?: string;
  channels: string[];
  createdAt: number;
  lastActiveAt: number;
  usage?: NodeUsage;
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
