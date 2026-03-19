import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import { isRequest, isResponse, isNotification, nextId, } from "./protocol.js";
/**
 * ACP Client handles the protocol handshake and ongoing communication
 * with a CLI agent over StdioTransport.
 */
export class AcpClient {
    transport;
    pending = new Map();
    authMethod;
    cwd;
    onUpdate;
    onReady;
    onError;
    sessionId;
    agentName;
    agentCapabilities;
    // Terminal management for reverse requests
    terminals = new Map();
    constructor(opts) {
        this.transport = opts.transport;
        this.authMethod = opts.authMethod;
        this.cwd = opts.cwd;
        this.onUpdate = opts.onUpdate;
        this.onReady = opts.onReady;
        this.onError = opts.onError;
        this.transport.onMessage((msg) => this.handleMessage(msg));
    }
    /** Start the ACP handshake sequence */
    async handshake() {
        try {
            // Step 1: initialize
            const initResult = await this.request("initialize", {
                protocolVersion: 1,
                clientInfo: { name: "nerve", version: "0.1.0" },
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: true,
                },
            }, 15000);
            this.agentName = initResult.agentInfo?.name;
            this.agentCapabilities = initResult.capabilities;
            // Step 2: authenticate (optional)
            if (this.authMethod) {
                await this.request("authenticate", {
                    authMethod: this.authMethod,
                }, 15000);
            }
            // Step 3: session/new
            const sessionResult = await this.requestWithRetry("session/new", {
                cwd: this.cwd,
                mcpServers: [],
            }, 30000, 2);
            this.sessionId = sessionResult.sessionId;
            this.onReady?.(this.sessionId);
        }
        catch (err) {
            this.onError?.(`handshake failed: ${err}`);
        }
    }
    /** List all sessions from the agent */
    async sessionList() {
        try {
            const result = await this.request("session/list", {}, 15000);
            return { sessions: result.sessions };
        }
        catch (err) {
            return { error: String(err) };
        }
    }
    /** Load/resume a previous session (agent pushes history via session/update) */
    async sessionLoad(sessionId) {
        try {
            await this.request("session/load", { sessionId }, 30000);
            this.sessionId = sessionId;
            return {};
        }
        catch (err) {
            return { error: String(err) };
        }
    }
    /** Send a prompt to the agent */
    async prompt(text) {
        if (!this.sessionId) {
            return { error: "no session" };
        }
        try {
            const result = await this.request("session/prompt", {
                sessionId: this.sessionId,
                prompt: [{ type: "text", text }],
            }, 300000); // 5min timeout for prompts
            return { stopReason: result.stopReason };
        }
        catch (err) {
            return { error: String(err) };
        }
    }
    async request(method, params, timeout) {
        return new Promise((resolve, reject) => {
            const id = nextId();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timeout after ${timeout}ms`));
            }, timeout);
            this.pending.set(id, (result, error) => {
                clearTimeout(timer);
                if (error)
                    reject(new Error(`${method}: ${error.message}`));
                else
                    resolve(result);
            });
            this.transport.send({
                jsonrpc: "2.0",
                id,
                method,
                params,
            });
        });
    }
    async requestWithRetry(method, params, timeout, retries) {
        for (let i = 0; i <= retries; i++) {
            try {
                return await this.request(method, params, timeout);
            }
            catch (err) {
                if (i === retries)
                    throw err;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        throw new Error("unreachable");
    }
    handleMessage(msg) {
        if (isResponse(msg)) {
            const cb = this.pending.get(msg.id);
            if (cb) {
                this.pending.delete(msg.id);
                cb(msg.result, msg.error);
            }
            return;
        }
        if (isNotification(msg)) {
            if (msg.method === "session/update") {
                this.onUpdate?.(msg.params || {});
            }
            return;
        }
        if (isRequest(msg)) {
            this.handleReverseRequest(msg);
            return;
        }
    }
    handleReverseRequest(req) {
        const { method, params, id } = req;
        const p = (params || {});
        switch (method) {
            case "session/request_permission":
                // Auto-approve (YOLO mode)
                this.sendResponse(id, { allowed: true });
                break;
            case "fs/read_text_file": {
                try {
                    const filePath = (p.path || p.filePath);
                    if (!filePath) {
                        this.sendError(id, -32602, "missing path");
                        break;
                    }
                    const content = readFileSync(filePath, "utf8");
                    const lines = content.split("\n");
                    const line = p.line || 0;
                    const limit = p.limit || lines.length;
                    const sliced = lines.slice(line, line + limit).join("\n");
                    this.sendResponse(id, { content: sliced });
                }
                catch (err) {
                    // File not found — return empty content (match nvim behavior)
                    this.sendResponse(id, { content: "" });
                }
                break;
            }
            case "fs/write_text_file": {
                try {
                    const filePath = (p.path || p.filePath);
                    mkdirSync(dirname(filePath), { recursive: true });
                    writeFileSync(filePath, p.content, "utf8");
                    this.sendResponse(id, {});
                }
                catch (err) {
                    this.sendError(id, -32000, `write failed: ${err}`);
                }
                break;
            }
            case "terminal/create": {
                const termId = nanoid(8);
                const cmd = p.command || "/bin/sh";
                const args = p.args || [];
                const proc = spawn(cmd, args, {
                    cwd: this.cwd,
                    env: process.env,
                    shell: true,
                });
                let output = "";
                proc.stdout?.on("data", (d) => { output += d.toString(); });
                proc.stderr?.on("data", (d) => { output += d.toString(); });
                this.terminals.set(termId, { process: proc, output: "" });
                // Store reference to track output
                const term = this.terminals.get(termId);
                proc.stdout?.on("data", () => { term.output = output; });
                proc.stderr?.on("data", () => { term.output = output; });
                this.sendResponse(id, { terminalId: termId });
                break;
            }
            case "terminal/output": {
                const termId = p.terminalId;
                const term = this.terminals.get(termId);
                if (term) {
                    this.sendResponse(id, { output: term.output });
                }
                else {
                    this.sendError(id, -32000, "terminal not found");
                }
                break;
            }
            case "terminal/wait_for_exit": {
                const termId = p.terminalId;
                const term = this.terminals.get(termId);
                if (term) {
                    if (term.process.exitCode !== null) {
                        this.sendResponse(id, { exitCode: term.process.exitCode });
                    }
                    else {
                        term.process.once("exit", (code) => {
                            this.sendResponse(id, { exitCode: code ?? 1 });
                        });
                    }
                }
                else {
                    this.sendError(id, -32000, "terminal not found");
                }
                break;
            }
            case "terminal/kill": {
                const termId = p.terminalId;
                const term = this.terminals.get(termId);
                if (term) {
                    term.process.kill("SIGTERM");
                    this.sendResponse(id, {});
                }
                else {
                    this.sendError(id, -32000, "terminal not found");
                }
                break;
            }
            case "terminal/release": {
                const termId = p.terminalId;
                const term = this.terminals.get(termId);
                if (term) {
                    term.process.kill("SIGTERM");
                    this.terminals.delete(termId);
                    this.sendResponse(id, {});
                }
                else {
                    this.sendError(id, -32000, "terminal not found");
                }
                break;
            }
            default:
                this.sendError(id, -32601, `method not found: ${method}`);
        }
    }
    sendResponse(id, result) {
        this.transport.send({
            jsonrpc: "2.0",
            id,
            result,
        });
    }
    sendError(id, code, message) {
        this.transport.send({
            jsonrpc: "2.0",
            id,
            error: { code, message },
        });
    }
    cleanup() {
        for (const [, term] of this.terminals) {
            term.process.kill("SIGTERM");
        }
        this.terminals.clear();
        this.pending.clear();
    }
}
//# sourceMappingURL=acp-client.js.map