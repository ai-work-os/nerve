export class BusNode {
    id;
    name;
    status;
    capabilities;
    permissions;
    transport;
    adapter;
    sessionId;
    channels = new Set();
    activity;
    createdAt;
    lastActiveAt;
    systemPrompt;
    prompted = false;
    // For stdio nodes: prompt generation counter (prevent stale callbacks)
    promptGen = 0;
    constructor(opts) {
        this.id = opts.id;
        this.name = opts.name;
        this.transport = opts.transport;
        this.capabilities = opts.capabilities || [];
        this.permissions = opts.permissions || "member";
        this.adapter = opts.adapter;
        this.status = "connecting";
        this.createdAt = Date.now();
        this.lastActiveAt = Date.now();
    }
    get isProcess() {
        return this.transport.type === "stdio";
    }
    get isWebSocket() {
        return this.transport.type === "websocket";
    }
    touch() {
        this.lastActiveAt = Date.now();
    }
    toInfo() {
        return {
            id: this.id,
            name: this.name,
            status: this.status,
            capabilities: this.capabilities,
            permissions: this.permissions,
            transport: this.transport.type,
            adapter: this.adapter,
            channels: [...this.channels],
            createdAt: this.createdAt,
            lastActiveAt: this.lastActiveAt,
        };
    }
}
//# sourceMappingURL=node.js.map