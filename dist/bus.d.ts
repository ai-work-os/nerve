import { Channel } from "./channel.js";
import { NodePool } from "./node-pool.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { BusNode } from "./node.js";
import type { MessageInfo, PermissionLevel } from "./protocol.js";
import type { WebSocket } from "ws";
export interface BusOptions {
    dataDir: string;
    port: number;
}
export declare class Bus {
    readonly store: Store;
    readonly nodePool: NodePool;
    readonly scheduler: Scheduler;
    private channels;
    private port;
    constructor(opts: BusOptions);
    createChannel(cwd: string, name?: string): Channel;
    getChannel(id: string): Channel | undefined;
    listChannels(): Channel[];
    closeChannel(id: string): void;
    registerNode(ws: WebSocket, name: string, capabilities: string[], permissions: PermissionLevel): BusNode;
    spawnNode(adapter: string, name: string, cwd: string): Promise<BusNode>;
    /** Spawn node and return ID immediately (handshake runs in background) */
    spawnNodeSync(adapter: string, name: string, cwd: string): string;
    stopNode(nodeId: string): void;
    addNodeToChannel(channelId: string, nodeId: string, nodeName?: string): void;
    removeNodeFromChannel(channelId: string, nodeName: string): void;
    postMessage(channelId: string, from: string, content: string): MessageInfo | null;
    /** Post from a Process Node (via terminal/curl HTTP endpoint) */
    postFromProcess(nodeName: string, content: string): void;
    getHistory(channelId: string, limit?: number, before?: number): MessageInfo[];
    private buildSystemPrompt;
    private broadcastToChannel;
    private handleNodeEvent;
    shutdown(): Promise<void>;
}
