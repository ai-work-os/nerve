/**
 * Scheduler manages per-node message queues for Process Nodes (stdio).
 * Ensures serial prompt execution: one prompt at a time per node.
 */
export class Scheduler {
    queues = new Map();
    busy = new Set();
    maxQueueSize = 10;
    promptFn;
    constructor(promptFn) {
        this.promptFn = promptFn;
    }
    enqueue(nodeId, channelId, message) {
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
    dispatch(nodeId) {
        const queue = this.queues.get(nodeId);
        if (!queue || queue.length === 0) {
            this.busy.delete(nodeId);
            return;
        }
        const item = queue.shift();
        this.busy.add(nodeId);
        this.promptFn(nodeId, item.message.content, () => {
            this.dispatch(nodeId);
        });
    }
    isNodeBusy(nodeId) {
        return this.busy.has(nodeId);
    }
    clearQueue(nodeId) {
        this.queues.delete(nodeId);
        this.busy.delete(nodeId);
    }
}
//# sourceMappingURL=scheduler.js.map