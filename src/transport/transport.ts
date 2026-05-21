import { ChildProcess, spawn } from "node:child_process";
import type { WebSocket } from "ws";
import { LineBuffer, type JsonRpcMessage } from "./protocol.js";
import * as log from "../infra/logger.js";
import { child as childLogger, newCorrelationId } from "../infra/logger.js";

export type MessageHandler = (msg: JsonRpcMessage) => void;
export type CloseHandler = (code: number | null) => void;

export interface Transport {
  send(msg: JsonRpcMessage): void;
  onMessage(handler: MessageHandler): void;
  onClose(handler: CloseHandler): void;
  close(): void;
  readonly alive: boolean;
  readonly type: "stdio" | "websocket" | "local";
}

// ------- Stdio Transport (for CLI agents) -------

export interface StdioSpawnOptions {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class StdioTransport implements Transport {
  readonly type = "stdio" as const;
  private process: ChildProcess | null = null;
  private lineBuf = new LineBuffer();
  private msgHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private _alive = false;

  get alive() { return this._alive; }
  get pid() { return this.process?.pid; }

  spawn(opts: StdioSpawnOptions): void {
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

    this.process.stdout!.setEncoding("utf8");
    this.process.stdout!.on("data", (chunk: string) => {
      const lines = this.lineBuf.feed(chunk);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          this.msgHandler?.(msg);
        } catch {
          // ignore non-JSON lines (e.g. agent stderr leak)
        }
      }
    });

    this.process.stderr!.setEncoding("utf8");
    this.process.stderr!.on("data", (chunk: string) => {
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

  send(msg: JsonRpcMessage): void {
    if (!this._alive || !this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  onMessage(handler: MessageHandler): void {
    this.msgHandler = handler;
  }

  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.process && this._alive) {
      this.process.kill("SIGTERM");
      // Force kill after 5s
      const timer = setTimeout(() => {
        if (this._alive) this.process?.kill("SIGKILL");
      }, 5000);
      this.process.on("exit", () => clearTimeout(timer));
    }
  }
}

// ------- Null Transport (placeholder for program nodes before WS connect) -------

export class NullTransport implements Transport {
  // Reports "websocket" because program nodes will be bound to a WebSocketTransport
  // once the spawned process connects back. This placeholder is short-lived.
  readonly type = "websocket" as const;
  get alive() { return false; }
  send(): void {}
  onMessage(): void {}
  onClose(): void {}
  close(): void {}
}

// ------- Local Transport (for in-process nodes) -------

/** LocalTransport — for modules that live inside the nerve process but
 *  should appear in node.list as nodes (e.g. service-supervisor exposing
 *  its supervised-services state). Send is a no-op: in-process nodes are
 *  driven by direct method calls, not by JSON-RPC notifications coming
 *  back over the wire. They never close on their own — caller controls
 *  lifecycle via NodePool.removeLocalNode. */
export class LocalTransport implements Transport {
  readonly type = "local" as const;
  private _alive = true;
  private closeHandler: CloseHandler | null = null;

  get alive() { return this._alive; }
  send(): void { /* in-process, no wire */ }
  onMessage(): void { /* in-process nodes do not receive RPC */ }
  onClose(handler: CloseHandler): void { this.closeHandler = handler; }
  close(): void {
    if (!this._alive) return;
    this._alive = false;
    this.closeHandler?.(null);
  }
}

// ------- WebSocket Transport (for external clients) -------

export class WebSocketTransport implements Transport {
  readonly type = "websocket" as const;
  private msgHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as JsonRpcMessage;
        const correlationId = newCorrelationId();
        const wsLog = childLogger({ module: "transport:ws", correlationId });
        wsLog.boundary("in", "ws", { method: (msg as any).method, id: (msg as any).id });
        this.msgHandler?.(msg);
      } catch {
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

  /** The underlying WebSocket — used for stale-close identity checks
   *  (verifying a closing socket is still the node's current transport). */
  get socket(): WebSocket {
    return this.ws;
  }

  send(msg: JsonRpcMessage): void {
    if (this.alive) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): void {
    this.msgHandler = handler;
  }

  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.ws.close();
  }
}
