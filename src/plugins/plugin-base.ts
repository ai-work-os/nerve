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

import { CommandResult, formatCommandResponse, formatHelpText, formatUnknownCommand, formatReportError } from "../command-feedback.js";
export type { CommandResult };

export interface CommandDef {
  description: string;
  args?: Record<string, string>;
}

/**
 * Normalize command args: map positional ("0","1",...) to named keys
 * using CommandDef.args key order. Last declared arg eats remaining positionals.
 * If any declared arg name already present in rawArgs (MCP path), pass through as-is.
 */
export function normalizeArgs(rawArgs: Record<string, string>, argDef?: Record<string, string>): Record<string, string> {
  if (!argDef) return rawArgs;
  const argNames = Object.keys(argDef);
  if (argNames.length === 0) return rawArgs;

  if (argNames.some(name => rawArgs[name] !== undefined)) return rawArgs;

  const positional: string[] = [];
  for (let i = 0; rawArgs[String(i)] !== undefined; i++) positional.push(rawArgs[String(i)]);
  if (positional.length === 0) return rawArgs;

  const result: Record<string, string> = {};
  for (let i = 0; i < argNames.length && i < positional.length; i++) {
    if (i === argNames.length - 1) {
      result[argNames[i]] = positional.slice(i).join(" ");
    } else {
      result[argNames[i]] = positional[i];
    }
  }
  return result;
}

export interface Subscription {
  nodeName: string;
  filter?: string;
}

export function matchSubscribers(subs: Subscription[], tag?: string): string[] {
  const matched = subs.filter(s => !s.filter || s.filter === tag);
  return [...new Set(matched.map(s => s.nodeName))];
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
  private subscriptions = new Map<string, Subscription[]>();
  protected channelId?: string;

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

    // Track channel membership
    this.onNotification("channel.nodeJoined", (params: any) => {
      if (params?.nodeName === this.options.name) {
        this.channelId = params.channelId;
        this.log("info", `joined channel ${this.channelId}`);
      }
    });
    this.onNotification("channel.nodeLeft", (params: any) => {
      if (params?.nodeName === this.options.name && params?.channelId === this.channelId) {
        this.log("info", `left channel ${this.channelId}`);
        this.channelId = undefined;
      }
      if (params?.nodeName) this.removeSubscriptionsFor(params.nodeName);
    });
    this.onNotification("node.stopped", (params: any) => {
      if (params?.name) this.removeSubscriptionsFor(params.name);
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
    const commands = this.getAllCommands();
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
  protected onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {}

  /** Parse message content into command + args, dispatch to onCommand or log error.
   *  When channelId is provided (called from channel context), errors are posted back to the channel. */
  protected dispatchCommand(content: string, from?: string, channelId?: string): void {
    const commands = this.getAllCommands();
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
      const msgs = formatHelpText(commands, from);
      if (channelId && msgs.length > 0) {
        for (const m of msgs) this.postToChannel(channelId, m);
      } else {
        // Fallback: log help text
        for (const [name, def] of Object.entries(commands)) {
          const argStr = def.args ? " " + Object.keys(def.args).join(" ") : "";
          this.log("info", `  ${name}${argStr}  — ${def.description || ""}`);
        }
        this.log("info", "  help  — Show this help");
      }
      return;
    }

    if (!commands[cmd]) {
      const available = Object.keys(commands);
      const msg = `unknown command: "${cmd}". available: ${available.join(", ")}`;
      this.log("error", msg);
      if (channelId) {
        const msgs = formatUnknownCommand(cmd, available, from);
        for (const m of msgs) this.postToChannel(channelId, m);
      }
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

    const normalized = normalizeArgs(args, commands[cmd]?.args);
    const builtinResult = this.handleBuiltinCommand(cmd, normalized, from);
    const result = builtinResult !== false ? builtinResult : this.onCommand(cmd, normalized, from);
    const msgs = formatCommandResponse(result, from);
    if (channelId) {
      for (const m of msgs) this.postToChannel(channelId, m);
    }
  }

  /** Report error to channel (@mention) + log. For async operations. */
  protected reportError(channelId: string | undefined, to: string | undefined, message: string): void {
    const msg = formatReportError(to, message);
    if (channelId && msg) {
      this.postToChannel(channelId, msg);
    }
    this.log("error", message);
  }

  /** Post a message to a channel (best-effort) */
  protected postToChannel(channelId: string, content: string): void {
    this.request("channel.post", { channelId, content }).catch(err => {
      this.log("warn", `channel reply failed: ${err.message}`);
    });
  }

  // --- Subscription system ---

  private getAllCommands(): Record<string, CommandDef> {
    const base: Record<string, CommandDef> = {};
    if (this.getEvents().length > 0) {
      base.subscribe = { description: "Subscribe to events", args: { event: "event type", filter: "optional filter" } };
      base.unsubscribe = { description: "Unsubscribe from events", args: { event: "event type", filter: "optional filter" } };
      base.subscribers = { description: "List all subscriptions" };
    }
    return { ...base, ...this.getCommands() };
  }

  private handleBuiltinCommand(cmd: string, args: Record<string, string>, from?: string): CommandResult | false {
    switch (cmd) {
      case "subscribe": return this.handleSubscribe(args, from);
      case "unsubscribe": return this.handleUnsubscribe(args, from);
      case "subscribers": return this.handleListSubscribers();
      default: return false;
    }
  }

  private handleSubscribe(args: Record<string, string>, from?: string): CommandResult {
    const parsed = this.parseEventArg(args.event);
    if (!parsed) {
      this.log("warn", `subscribe: invalid event "${args.event}" from ${from || "unknown"}, available: ${this.getEvents().join(", ")}`);
      return { reply: `格式：subscribe <event> [filter]\n可用事件: ${this.getEvents().join(", ")}` };
    }
    const { event, filter: parsedFilter } = parsed;
    const filter = args.filter || parsedFilter;
    const nodeName = args.name || from;
    if (!nodeName || nodeName === "unknown") {
      this.log("warn", `subscribe: cannot determine subscriber from=${from}`);
      return { reply: "无法确定订阅者" };
    }

    const subs = this.subscriptions.get(event) || [];
    if (subs.some(s => s.nodeName === nodeName && s.filter === filter)) {
      this.log("debug", `subscribe: ${nodeName} already subscribed to ${event}${filter ? ":" + filter : ""}`);
      return { reply: `${nodeName} 已订阅 ${event}${filter ? ":" + filter : ""}` };
    }
    subs.push({ nodeName, filter });
    this.subscriptions.set(event, subs);
    this.log("info", `subscribed: ${nodeName} → ${event}${filter ? ":" + filter : ""}`);
    return { reply: `已订阅: ${event}${filter ? ":" + filter : ""}` };
  }

  private handleUnsubscribe(args: Record<string, string>, from?: string): CommandResult {
    const parsed = this.parseEventArg(args.event);
    if (!parsed) return { reply: `格式：unsubscribe <event> [filter]` };
    const { event, filter: parsedFilter } = parsed;
    const filter = args.filter || parsedFilter;
    const nodeName = args.name || from;
    if (!nodeName) return { reply: "无法确定订阅者" };

    const subs = this.subscriptions.get(event) || [];
    const idx = subs.findIndex(s => s.nodeName === nodeName && s.filter === filter);
    if (idx < 0) return { reply: `${nodeName} 未订阅 ${event}${filter ? ":" + filter : ""}` };
    subs.splice(idx, 1);
    this.log("info", `unsubscribed: ${nodeName} ← ${event}${filter ? ":" + filter : ""}`);
    return { reply: `已取消: ${event}${filter ? ":" + filter : ""}` };
  }

  private handleListSubscribers(): CommandResult {
    const lines: string[] = [];
    for (const [event, subs] of this.subscriptions) {
      for (const s of subs) {
        lines.push(`${s.nodeName} → ${event}${s.filter ? ":" + s.filter : ""}`);
      }
    }
    return { reply: lines.length > 0 ? lines.join("\n") : "无订阅" };
  }

  private parseEventArg(raw?: string): { event: string; filter?: string } | null {
    if (!raw) return null;
    const events = this.getEvents();
    if (events.includes(raw)) return { event: raw };
    const colon = raw.indexOf(":");
    if (colon > 0) {
      const event = raw.slice(0, colon);
      const filter = raw.slice(colon + 1);
      if (events.includes(event)) return { event, filter };
    }
    return null;
  }

  private removeSubscriptionsFor(nodeName: string): void {
    let removed = 0;
    for (const [event, subs] of this.subscriptions) {
      const before = subs.length;
      const filtered = subs.filter(s => s.nodeName !== nodeName);
      if (filtered.length < before) {
        this.subscriptions.set(event, filtered);
        removed += before - filtered.length;
      }
    }
    if (removed > 0) this.log("info", `auto-unsubscribed ${nodeName} (${removed} subscriptions)`);
  }

  protected async emit(event: string, tag: string | undefined, content: string): Promise<void> {
    if (!this.channelId) {
      this.log("warn", `emit ${event}: no channel`);
      return;
    }
    const subs = this.subscriptions.get(event) || [];
    const names = matchSubscribers(subs, tag);
    if (names.length === 0) {
      this.log("debug", `emit ${event}${tag ? ":" + tag : ""}: no subscribers`);
      return;
    }
    const mentions = names.map(n => `@${n}`).join(" ");
    try {
      await this.request("channel.post", { channelId: this.channelId, content: `${mentions} ${content}` });
      this.log("info", `emit ${event}${tag ? ":" + tag : ""}: notified [${names.join(",")}]`);
    } catch (err: any) {
      this.log("warn", `emit failed: ${err.message}`);
    }
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
          const commands = this.getAllCommands();
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

        // Response to a request we sent
        if (msg.id !== undefined && !msg.method) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
          return;
        }

        // Incoming request (server → plugin): has both method and id
        if (msg.method && msg.id !== undefined) {
          if (msg.method === "node.command") {
            const { command, args, from } = msg.params || {};
            const commands = this.getAllCommands();
            if (!commands[command]) {
              const available = Object.keys(commands).join(", ");
              this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown command "${command}". available: ${available}` } });
              return;
            }
            const normalized = normalizeArgs(args || {}, commands[command]?.args);
            const builtinResult = this.handleBuiltinCommand(command, normalized, from);
            const result = builtinResult !== false ? builtinResult : this.onCommand(command, normalized, from);
            const reply = typeof result === "string" ? { error: result } : (result || {});
            this.send({ jsonrpc: "2.0", id: msg.id, result: reply });
            return;
          }
          this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
          return;
        }

        // Notification (method only, no id)
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
