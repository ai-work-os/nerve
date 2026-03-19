import type { MessageInfo } from "./protocol.js";
import type { Store } from "./store.js";
export declare class Channel {
    readonly id: string;
    name?: string;
    cwd: string;
    nodes: Map<string, string>;
    createdAt: number;
    constructor(opts: {
        id?: string;
        cwd: string;
        name?: string;
        store: Store;
    });
    addNode(nodeId: string, nodeName: string, store: Store): void;
    removeNode(nodeName: string, store: Store): void;
    hasNode(nodeName: string): boolean;
    getNodeId(nodeName: string): string | undefined;
    postMessage(from: string, content: string, store: Store): MessageInfo;
}
