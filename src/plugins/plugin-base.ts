/**
 * Plugin Base — common infrastructure for nerve plugin nodes.
 *
 * Provides: WS connection, node.register, JSON-RPC request/notify,
 * auto-reconnect, and structured logging.
 */

import WebSocket from "ws";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface PluginOptions {
  port: number;
  name: string;
  capabilities?: string[];
  permissions?: "operator" | "member" | "observer";
  reconnectDelay?: number;  // ms, default 5000
}

type PendingResolve = (result: any) => void;
type PendingReject = (error: Error) => void;

export class PluginBase {
  protected ws!: WebSocket;
  protected nodeId?: string;
  protected options: Required<PluginOptions>;
  /** Persistent data directory: ~/.nerve/plugins/{name}/ */
  protected dataDir: string;
  private logPath: string;
  private reqId = 1;
  private pending = new Map<number, { resolve: PendingResolve; reject: PendingReject }>();
  private notificationHandlers = new Map<string, (params: any) => void>();
  private connected = false;
  private stopped = false;

  constructor(opts: PluginOptions) {
    this.options = {
      capabilities: ["monitor"],
      permissions: "observer",
      reconnectDelay: 5000,
      ...opts,
    };
    this.dataDir = resolve(homedir(), `.nerve/plugins/${this.options.name}`);
    this.logPath = resolve(this.dataDir, "activity.log");
    mkdirSync(this.dataDir, { recursive: true });
  }

  /** Start the plugin: connect → register → onReady() */
  async start(): Promise<void> {
    await this.connect();
  }

  /** Stop the plugin gracefully */
  stop(): void {
    this.stopped = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  /** Override in subclass: called after successful registration */
  protected async onReady(): Promise<void> {}

  /** Override in subclass: called on disconnect (before reconnect) */
  protected onDisconnect(): void {}

  /** Send a JSON-RPC request and wait for response */
  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout (10s)`));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Register a handler for a notification method */
  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Structured log: stdout + activity.log file + node.log RPC (DM observability). */
  log(level: "info" | "warn" | "error", msg: string): void {
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase()}] ${msg}`;
    console.log(`${ts} [${this.options.name}] [${level.toUpperCase()}] ${msg}`);
    // Append to persistent activity.log
    appendFile(this.logPath, line + "\n").catch(() => {});
    // Push to server for DM view (best-effort, don't block or error)
    if (this.connected && this.nodeId) {
      this.request("node.log", { entries: [{ level, message: msg, ts }] }).catch(() => {});
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async connect(): Promise<void> {
    const url = `ws://127.0.0.1:${this.options.port}`;
    this.log("info", `connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", async () => {
        this.connected = true;
        this.log("info", "connected");

        try {
          // Register as node
          const reg = await this.request("node.register", {
            name: this.options.name,
            capabilities: this.options.capabilities,
            permissions: this.options.permissions,
          });
          this.nodeId = reg.nodeId;
          this.log("info", `registered as ${this.nodeId} (${reg.name})`);

          await this.onReady();
          resolve();
        } catch (err) {
          this.log("error", `registration failed: ${err}`);
          reject(err);
        }
      });

      this.ws.on("message", (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        // Response to a request
        if (msg.id !== undefined && !msg.method) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
          return;
        }

        // Notification
        if (msg.method) {
          const handler = this.notificationHandlers.get(msg.method);
          if (handler) handler(msg.params);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.onDisconnect();
        if (!this.stopped) {
          this.log("warn", `disconnected, reconnecting in ${this.options.reconnectDelay}ms`);
          setTimeout(() => {
            if (!this.stopped) {
              this.connect().catch((err) => {
                this.log("error", `reconnect failed: ${err}`);
              });
            }
          }, this.options.reconnectDelay);
        }
      });

      this.ws.on("error", (err) => {
        this.log("error", `ws error: ${err.message}`);
        if (!this.connected) reject(err);
      });
    });
  }
}
