import { Bus } from "./bus.js";
export declare class Server {
    private bus;
    private wss;
    private httpServer;
    private port;
    private wsNodeMap;
    constructor(bus: Bus, port: number);
    start(): void;
    private handleRequest;
    /**
     * HTTP API for Process Nodes (CLI agents) to manage Bus via terminal/curl.
     * All POST endpoints accept JSON body with `from` field to identify the caller node.
     */
    private handleHttp;
    private handleHttpRoute;
    private sendResult;
    private sendError;
    shutdown(): Promise<void>;
}
