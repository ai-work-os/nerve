import { BusNode } from "./node.js";
import type { Store } from "./store.js";
import type { PermissionLevel } from "./protocol.js";
import type { WebSocket } from "ws";
export type NodeEventHandler = (event: string, node: BusNode, detail?: Record<string, unknown>) => void;
export declare class NodePool {
    private nodes;
    private acpClients;
    private nameIndex;
    private onEvent;
    private store;
    constructor(store: Store, onEvent: NodeEventHandler);
    get(id: string): BusNode | undefined;
    getByName(name: string): BusNode | undefined;
    isNameTaken(name: string): boolean;
    listAll(): BusNode[];
    /** Register a WebSocket node (nvim, browser, CLI tool) */
    registerWebSocket(ws: WebSocket, name: string, capabilities: string[], permissions: PermissionLevel): BusNode;
    /** Spawn a Process Node synchronously (handshake runs in background) */
    spawnProcessSync(adapterName: string, name: string, cwd: string, busPort: number): BusNode;
    /** Spawn a Process Node (CLI agent) */
    spawnProcess(adapterName: string, name: string, cwd: string, busPort: number): Promise<BusNode>;
    private _spawnProcess;
    /** Prompt a Process Node */
    promptNode(nodeId: string, text: string): Promise<{
        stopReason?: string;
        error?: string;
    }>;
    /** List sessions from a Process Node */
    sessionList(nodeId: string): Promise<{
        sessions?: Array<{
            sessionId: string;
        }>;
        error?: string;
    }>;
    /** Load/resume a session on a Process Node */
    sessionLoad(nodeId: string, sessionId: string): Promise<{
        error?: string;
    }>;
    /** Stop a Process Node */
    stopNode(nodeId: string): void;
    /** Remove a node from the pool */
    remove(nodeId: string): void;
    /** Shutdown all nodes */
    shutdown(): Promise<void>;
}
