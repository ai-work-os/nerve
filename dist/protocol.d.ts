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
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: Record<string, unknown>;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
export declare function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest;
export declare function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse;
export declare function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification;
export declare function nextId(): number;
export declare function encodeRequest(id: number | string, method: string, params?: Record<string, unknown>): string;
export declare function encodeResponse(id: number | string, result: unknown): string;
export declare function encodeError(id: number | string, code: number, message: string): string;
export declare function encodeNotification(method: string, params?: Record<string, unknown>): string;
export declare class LineBuffer {
    private buf;
    feed(chunk: string): string[];
}
export type NodeStatus = "connecting" | "idle" | "busy" | "error" | "stopped";
export type PermissionLevel = "operator" | "member" | "observer";
export interface NodeInfo {
    id: string;
    name: string;
    status: NodeStatus;
    capabilities: string[];
    permissions: PermissionLevel;
    transport: "stdio" | "websocket";
    adapter?: string;
    channels: string[];
    createdAt: number;
    lastActiveAt: number;
}
export interface ChannelInfo {
    id: string;
    name?: string;
    cwd: string;
    nodes: Record<string, string>;
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
