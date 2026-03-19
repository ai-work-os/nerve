import type { StdioTransport } from "./transport.js";
export interface AcpClientOptions {
    transport: StdioTransport;
    authMethod?: string;
    cwd: string;
    onUpdate?: (params: Record<string, unknown>) => void;
    onReady?: (sessionId: string) => void;
    onError?: (err: string) => void;
}
/**
 * ACP Client handles the protocol handshake and ongoing communication
 * with a CLI agent over StdioTransport.
 */
export declare class AcpClient {
    private transport;
    private pending;
    private authMethod?;
    private cwd;
    private onUpdate?;
    private onReady?;
    private onError?;
    sessionId?: string;
    agentName?: string;
    agentCapabilities?: Record<string, unknown>;
    private terminals;
    constructor(opts: AcpClientOptions);
    /** Start the ACP handshake sequence */
    handshake(): Promise<void>;
    /** List all sessions from the agent */
    sessionList(): Promise<{
        sessions?: Array<{
            sessionId: string;
            [key: string]: unknown;
        }>;
        error?: string;
    }>;
    /** Load/resume a previous session (agent pushes history via session/update) */
    sessionLoad(sessionId: string): Promise<{
        error?: string;
    }>;
    /** Send a prompt to the agent */
    prompt(text: string): Promise<{
        stopReason?: string;
        error?: string;
    }>;
    private request;
    private requestWithRetry;
    private handleMessage;
    private handleReverseRequest;
    private sendResponse;
    private sendError;
    cleanup(): void;
}
