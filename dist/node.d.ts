import type { Transport } from "./transport.js";
import type { NodeStatus, PermissionLevel, NodeInfo } from "./protocol.js";
export declare class BusNode {
    readonly id: string;
    name: string;
    status: NodeStatus;
    capabilities: string[];
    permissions: PermissionLevel;
    transport: Transport;
    adapter?: string;
    sessionId?: string;
    channels: Set<string>;
    activity?: string;
    createdAt: number;
    lastActiveAt: number;
    systemPrompt?: string;
    prompted: boolean;
    promptGen: number;
    constructor(opts: {
        id: string;
        name: string;
        transport: Transport;
        capabilities?: string[];
        permissions?: PermissionLevel;
        adapter?: string;
    });
    get isProcess(): boolean;
    get isWebSocket(): boolean;
    touch(): void;
    toInfo(): NodeInfo;
}
