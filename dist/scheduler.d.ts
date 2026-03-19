import type { MessageInfo } from "./protocol.js";
export interface QueueItem {
    channelId: string;
    message: MessageInfo;
}
export type PromptFn = (nodeId: string, text: string, onDone: () => void) => void;
/**
 * Scheduler manages per-node message queues for Process Nodes (stdio).
 * Ensures serial prompt execution: one prompt at a time per node.
 */
export declare class Scheduler {
    private queues;
    private busy;
    private maxQueueSize;
    private promptFn;
    constructor(promptFn: PromptFn);
    enqueue(nodeId: string, channelId: string, message: MessageInfo): boolean;
    private dispatch;
    isNodeBusy(nodeId: string): boolean;
    clearQueue(nodeId: string): void;
}
