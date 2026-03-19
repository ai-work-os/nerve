import type { MessageInfo } from "./protocol.js";
export declare class Store {
    private db;
    constructor(dbPath: string);
    private init;
    insertChannel(id: string, cwd: string, name?: string): void;
    closeChannel(id: string): void;
    listChannels(): Array<{
        id: string;
        name: string | null;
        cwd: string;
        createdAt: number;
    }>;
    insertNode(id: string, name: string, transport: string, adapter?: string, capabilities?: string[], cwd?: string): void;
    updateNodeStatus(id: string, status: string, sessionId?: string, pid?: number): void;
    markAllNodesStopped(): void;
    addNodeToChannel(channelId: string, nodeId: string, nodeName: string): void;
    removeNodeFromChannel(channelId: string, nodeName: string): void;
    getChannelNodes(channelId: string): Array<{
        nodeId: string;
        nodeName: string;
    }>;
    insertMessage(msg: MessageInfo): void;
    getMessages(channelId: string, limit?: number, before?: number): MessageInfo[];
    close(): void;
}
