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

export interface CommandDef {
  description: string;
  args?: Record<string, string>;
}

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
    // Environment variables take priority when spawned by nerve (NERVE_SPAWNED=1)
    const useEnv = process.env.NERVE_SPAWNED === "1";
    this.options = {
      capabilities: ["monitor"],
      permissions: "observer",
      reconnectDelay: 5000,
      ...opts,
      ...(useEnv && process.env.NERVE_PORT ? { port: parseInt(process.env.NERVE_PORT) } : {}),
      ...(useEnv && process.env.NERVE_NODE_NAME ? { name: process.env.NERVE_NODE_NAME } : {}),
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

  /** Override in subclass: register notification handlers before node.register.
   *  Call super.registerNotifications() to keep default node.message and channel.message handlers. */
  protected registerNotifications(): void {
    this.onNotification("node.message", (params: any) => {
      this.dispatchCommand(params?.content as string, params?.from as string);
    });

    // Handle @mention commands from channel messages
    this.onNotification("channel.message", (params: any) => {
      this.handleChannelMessage(params);
    });

    // DM capture events (override onDmPrompt/onDmResponse in subclass to handle)
    this.onNotification("dm.prompt", (params: any) => {
      this.onDmPrompt?.(params);
    });
    this.onNotification("dm.response", (params: any) => {
      this.onDmResponse?.(params);
    });
  }

  /** Override in subclass to handle DM prompt events */
  protected onDmPrompt?(params: any): void;
  /** Override in subclass to handle DM response events */
  protected onDmResponse?(params: any): void;

  /** Handle channel message: dispatch @mention commands.
   *  Override in subclass for custom channel message handling. */
  protected handleChannelMessage(params: any): void {
    const content = (params?.message?.content ?? params?.content) as string;
    if (!content) return;
    const from = (params?.message?.from ?? params?.from) as string | undefined;
    const channelId = params?.channelId as string | undefined;

    // Only respond to messages explicitly @mentioning this node
    const mentionPrefix = `@${this.options.name}`;
    if (!content.startsWith(mentionPrefix)) return;

    const stripped = content.slice(mentionPrefix.length).trim();
    if (!stripped) return;

    // Only dispatch known commands and help; ignore agent chatter silently
    const firstWord = stripped.split(/\s+/)[0].toLowerCase();
    const commands = this.getCommands();
    if (!commands[firstWord] && firstWord !== "help") return;

    this.dispatchCommand(stripped, from, channelId);
  }

  /** Override in subclass: called on disconnect (before reconnect) */
  protected onDisconnect(): void {}

  /** Override in subclass: called when a DM message is received */
  protected onMessage(content: string, from?: string): void {}

  /** Override in subclass: declare supported commands */
  getCommands(): Record<string, CommandDef> { return {}; }

  /** Override in subclass: declare emitted events */
  getEvents(): string[] { return []; }

  /** Override in subclass: handle a parsed command.
   *  Return a string to signal an error (posted back to channel if called from channel context).
   *  Return void/undefined for success (no channel reply). */
  protected onCommand(command: string, args: Record<string, string>, from?: string): string | void {}

  /** Parse message content into command + args, dispatch to onCommand or log error.
   *  When channelId is provided (called from channel context), errors are posted back to the channel. */
  protected dispatchCommand(content: string, from?: string, channelId?: string): void {
    const commands = this.getCommands();
    if (Object.keys(commands).length === 0) {
      // No commands declared — fall through to onMessage
      this.onMessage(content, from);
      return;
    }

    const trimmed = content.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    this.log("debug", `dispatchCommand: "${cmd}" from=${from || "unknown"}`);

    if (cmd === "help") {
      this.log("info", `help requested by ${from || "unknown"}`);
      this.log("info", "可用命令：");
      for (const [name, def] of Object.entries(commands)) {
        const argStr = def.args ? " " + Object.keys(def.args).join(" ") : "";
        this.log("info", `  ${name}${argStr}  — ${def.description || ""}`);
      }
      this.log("info", "  help  — Show this help");
      return;
    }

    if (!commands[cmd]) {
      const available = Object.keys(commands).join(", ");
      const msg = `unknown command: "${cmd}". available: ${available}`;
      this.log("error", msg);
      if (channelId) this.postToChannel(channelId, msg);
      return;
    }

    // Parse key=value args from remaining parts.
    // NOTE: values with spaces are not supported (e.g. source="my mic").
    // Use single-word values or key=value format.
    const args: Record<string, string> = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (eq > 0) {
        args[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
      } else {
        // Positional: use index as key
        args[String(i - 1)] = parts[i];
      }
    }

    const error = this.onCommand(cmd, args, from);
    if (error && channelId) {
      this.postToChannel(channelId, error);
    }
  }

  /** Post a message to a channel (best-effort) */
  private postToChannel(channelId: string, content: string): void {
    this.request("channel.post", { channelId, content }).catch(err => {
      this.log("warn", `channel reply failed: ${err.message}`);
    });
  }

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
  log(level: "info" | "warn" | "error" | "debug", msg: string): void {
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
          const commands = this.getCommands();
          const events = this.getEvents();
          const regParams: Record<string, unknown> = {
            name: this.options.name,
            capabilities: this.options.capabilities,
            permissions: this.options.permissions,
          };
          if (Object.keys(commands).length > 0) regParams.commands = commands;
          if (events.length > 0) regParams.events = events;
          // Register notification handlers BEFORE node.register to avoid race condition:
          // server may send notifications (e.g. scene on_ready, channel.nodeJoined)
          // in the same TCP segment as the register response.
          this.registerNotifications();

          const reg = await this.request("node.register", regParams);
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
        // nerve-spawned 插件断连后不重连，直接退出
        if (process.env.NERVE_SPAWNED === "1") {
          this.stopped = true;
          this.log("info", "nerve-spawned plugin disconnected, exiting");
          this.exitProcess();
          return;
        }
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

  protected exitProcess(): void {
    process.exit(0);
  }
}
