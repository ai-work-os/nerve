import { spawn } from "node:child_process";
import { LineBuffer } from "./protocol.js";
import * as log from "./logger.js";
export class StdioTransport {
    type = "stdio";
    process = null;
    lineBuf = new LineBuffer();
    msgHandler = null;
    closeHandler = null;
    _alive = false;
    get alive() { return this._alive; }
    get pid() { return this.process?.pid; }
    spawn(opts) {
        const env = { ...process.env, ...opts.env };
        // Remove Claude Code env vars to prevent child agents from detecting parent session
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
        this.process = spawn(opts.cmd, opts.args, {
            cwd: opts.cwd || process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this._alive = true;
        this.process.stdout.setEncoding("utf8");
        this.process.stdout.on("data", (chunk) => {
            const lines = this.lineBuf.feed(chunk);
            for (const line of lines) {
                try {
                    const msg = JSON.parse(line);
                    this.msgHandler?.(msg);
                }
                catch {
                    // ignore non-JSON lines (e.g. agent stderr leak)
                }
            }
        });
        this.process.stderr.setEncoding("utf8");
        this.process.stderr.on("data", (chunk) => {
            // Log stderr but don't parse as JSON-RPC
            log.debug(`agent:${this.process?.pid} stderr: ${chunk.trim()}`);
        });
        this.process.on("exit", (code) => {
            this._alive = false;
            this.closeHandler?.(code);
        });
        this.process.on("error", (err) => {
            log.error(`agent:spawn ${err.message}`);
            this._alive = false;
            this.closeHandler?.(null);
        });
    }
    send(msg) {
        if (!this._alive || !this.process?.stdin?.writable)
            return;
        this.process.stdin.write(JSON.stringify(msg) + "\n");
    }
    onMessage(handler) {
        this.msgHandler = handler;
    }
    onClose(handler) {
        this.closeHandler = handler;
    }
    close() {
        if (this.process && this._alive) {
            this.process.kill("SIGTERM");
            // Force kill after 5s
            const timer = setTimeout(() => {
                if (this._alive)
                    this.process?.kill("SIGKILL");
            }, 5000);
            this.process.on("exit", () => clearTimeout(timer));
        }
    }
}
// ------- WebSocket Transport (for external clients) -------
export class WebSocketTransport {
    ws;
    type = "websocket";
    msgHandler = null;
    closeHandler = null;
    constructor(ws) {
        this.ws = ws;
        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.msgHandler?.(msg);
            }
            catch {
                // ignore malformed messages
            }
        });
        ws.on("close", (code) => {
            this.closeHandler?.(code);
        });
        ws.on("error", () => {
            this.closeHandler?.(null);
        });
    }
    get alive() {
        return this.ws.readyState === this.ws.OPEN;
    }
    send(msg) {
        if (this.alive) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    onMessage(handler) {
        this.msgHandler = handler;
    }
    onClose(handler) {
        this.closeHandler = handler;
    }
    close() {
        this.ws.close();
    }
}
//# sourceMappingURL=transport.js.map