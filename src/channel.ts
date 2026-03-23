import { nanoid } from "nanoid";
import type { MessageInfo } from "./protocol.js";
import type { Store } from "./store.js";

export class Channel {
  readonly id: string;
  name?: string;
  cwd: string;
  nodes = new Map<string, string>(); // nodeName → nodeId
  createdAt: number;

  constructor(opts: { id?: string; cwd: string; name?: string; store: Store }) {
    this.id = opts.id || nanoid(12);
    this.cwd = opts.cwd;
    this.name = opts.name;
    this.createdAt = Date.now();
    opts.store.insertChannel(this.id, this.cwd, this.name);
  }

  /** Restore a channel from DB without re-inserting */
  static restore(row: { id: string; name: string | null; cwd: string; createdAt: number }): Channel {
    const ch = Object.create(Channel.prototype) as Channel;
    Object.defineProperty(ch, "id", { value: row.id, writable: false, enumerable: true });
    ch.cwd = row.cwd;
    ch.name = row.name ?? undefined;
    ch.createdAt = row.createdAt;
    ch.nodes = new Map();
    return ch;
  }

  addNode(nodeId: string, nodeName: string, store: Store): void {
    this.nodes.set(nodeName, nodeId);
    store.addNodeToChannel(this.id, nodeId, nodeName);
  }

  removeNode(nodeName: string, store: Store): void {
    this.nodes.delete(nodeName);
    store.removeNodeFromChannel(this.id, nodeName);
  }

  hasNode(nodeName: string): boolean {
    return this.nodes.has(nodeName);
  }

  getNodeId(nodeName: string): string | undefined {
    return this.nodes.get(nodeName);
  }

  postMessage(from: string, content: string, store: Store): MessageInfo {
    const msg: MessageInfo = {
      id: nanoid(12),
      channelId: this.id,
      from,
      content,
      timestamp: Date.now(),
    };
    store.insertMessage(msg);
    return msg;
  }
}
