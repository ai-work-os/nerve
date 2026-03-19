import type { WebSocket } from "ws";
import { type JsonRpcMessage } from "./protocol.js";
export type MessageHandler = (msg: JsonRpcMessage) => void;
export type CloseHandler = (code: number | null) => void;
export interface Transport {
    send(msg: JsonRpcMessage): void;
    onMessage(handler: MessageHandler): void;
    onClose(handler: CloseHandler): void;
    close(): void;
    readonly alive: boolean;
    readonly type: "stdio" | "websocket";
}
export interface StdioSpawnOptions {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
}
export declare class StdioTransport implements Transport {
    readonly type: "stdio";
    private process;
    private lineBuf;
    private msgHandler;
    private closeHandler;
    private _alive;
    get alive(): boolean;
    get pid(): number | undefined;
    spawn(opts: StdioSpawnOptions): void;
    send(msg: JsonRpcMessage): void;
    onMessage(handler: MessageHandler): void;
    onClose(handler: CloseHandler): void;
    close(): void;
}
export declare class WebSocketTransport implements Transport {
    private ws;
    readonly type: "websocket";
    private msgHandler;
    private closeHandler;
    constructor(ws: WebSocket);
    get alive(): boolean;
    send(msg: JsonRpcMessage): void;
    onMessage(handler: MessageHandler): void;
    onClose(handler: CloseHandler): void;
    close(): void;
}
