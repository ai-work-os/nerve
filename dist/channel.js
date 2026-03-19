import { nanoid } from "nanoid";
export class Channel {
    id;
    name;
    cwd;
    nodes = new Map(); // nodeName → nodeId
    createdAt;
    constructor(opts) {
        this.id = opts.id || nanoid(12);
        this.cwd = opts.cwd;
        this.name = opts.name;
        this.createdAt = Date.now();
        opts.store.insertChannel(this.id, this.cwd, this.name);
    }
    addNode(nodeId, nodeName, store) {
        this.nodes.set(nodeName, nodeId);
        store.addNodeToChannel(this.id, nodeId, nodeName);
    }
    removeNode(nodeName, store) {
        this.nodes.delete(nodeName);
        store.removeNodeFromChannel(this.id, nodeName);
    }
    hasNode(nodeName) {
        return this.nodes.has(nodeName);
    }
    getNodeId(nodeName) {
        return this.nodes.get(nodeName);
    }
    postMessage(from, content, store) {
        const msg = {
            id: nanoid(12),
            channelId: this.id,
            from,
            content,
            timestamp: Date.now(),
        };
        store.insertMessage(msg);
        return msg;
    }
}
//# sourceMappingURL=channel.js.map