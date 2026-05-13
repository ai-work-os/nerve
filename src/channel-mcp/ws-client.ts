/**
 * WS JSON-RPC client used by nerve-channel to talk to the nerve server.
 *
 * Responsibilities:
 *  - Open a long-lived WS connection
 *  - Send JSON-RPC 2.0 requests, match responses by id
 *  - Fire onNotification for server-pushed notifications (channel.message, etc.)
 *  - Reject pending requests if the socket closes (caller decides retry)
 *
 * Reconnect logic is intentionally minimal: nerve-channel.ts schedules a fresh
 * `connect()` + `register()` after `onClose` fires.
 */

import WebSocket from "ws";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Notification = { method: string; params: Record<string, unknown> };

export class NerveWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifHandler: ((n: Notification) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private requestTimeoutMs: number;

  constructor(private url: string, opts: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.on("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.on("error", (err) => {
        if (!this.ws) reject(err); // failure during open
      });
      ws.on("message", (data) => this.handleMessage(data.toString()));
      ws.on("close", () => this.handleClose());
    });
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.notifHandler?.({ method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
    }
  }

  private handleClose(): void {
    const err = new Error("websocket closed");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.ws = null;
    this.closeHandler?.();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async register(name: string, capabilities: string[] = ["ui"]): Promise<{ nodeId: string; name: string }> {
    const result = await this.request<{ nodeId: string; name: string }>("node.register", {
      name,
      capabilities,
      permissions: "operator",
    });
    return result;
  }

  onNotification(handler: (n: Notification) => void): void {
    this.notifHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.resolve();
    return new Promise((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
  }
}
