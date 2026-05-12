import type { MessageInfo } from "./transport/protocol.js";

export interface QueueItem {
  channelId: string;
  message: MessageInfo;
}

export type PromptFn = (nodeId: string, text: string, onDone: () => void) => void;

/**
 * Scheduler manages per-node message queues for Process Nodes (stdio).
 * Ensures serial prompt execution: one prompt at a time per node.
 */
export class Scheduler {
  private queues = new Map<string, QueueItem[]>();
  private busy = new Set<string>();
  private maxQueueSize = 10;
  private promptFn: PromptFn;

  constructor(promptFn: PromptFn) {
    this.promptFn = promptFn;
  }

  enqueue(nodeId: string, channelId: string, message: MessageInfo): boolean {
    let queue = this.queues.get(nodeId);
    if (!queue) {
      queue = [];
      this.queues.set(nodeId, queue);
    }

    if (queue.length >= this.maxQueueSize) {
      return false; // queue full
    }

    queue.push({ channelId, message });

    if (!this.busy.has(nodeId)) {
      this.dispatch(nodeId);
    }

    return true;
  }

  private dispatch(nodeId: string): void {
    const queue = this.queues.get(nodeId);
    if (!queue || queue.length === 0) {
      this.busy.delete(nodeId);
      return;
    }

    const item = queue.shift()!;
    this.busy.add(nodeId);

    this.promptFn(nodeId, item.message.content, () => {
      this.dispatch(nodeId);
    });
  }

  isNodeBusy(nodeId: string): boolean {
    return this.busy.has(nodeId);
  }

  clearQueue(nodeId: string): void {
    this.queues.delete(nodeId);
    this.busy.delete(nodeId);
  }
}
