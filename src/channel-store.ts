import { Channel } from "./channel.js";
import type { Store } from "./store.js";
import type { MessageInfo } from "./protocol.js";
import * as log from "./infra/logger.js";

export class ChannelStore {
  private channels = new Map<string, Channel>();
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  create(cwd: string, name?: string): Channel {
    const ch = new Channel({ cwd, name, store: this.store });
    this.channels.set(ch.id, ch);
    return ch;
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  list(): Channel[] {
    return [...this.channels.values()];
  }

  restore(channelId: string): { channel: Channel; messages: MessageInfo[] } | null {
    if (this.channels.has(channelId)) {
      const ch = this.channels.get(channelId)!;
      const messages = this.store.getMessages(channelId, 50);
      return { channel: ch, messages };
    }
    const row = this.store.getChannelForRestore(channelId);
    if (!row) return null;
    const ch = Channel.restore(row);
    this.channels.set(ch.id, ch);
    log.info(`channel restored: ${ch.name || ch.id} (${ch.cwd})`);
    return { channel: ch, messages: this.store.getMessages(channelId, 50) };
  }

  close(id: string): Channel | undefined {
    const ch = this.channels.get(id);
    if (!ch) return undefined;
    this.store.closeChannel(id);
    this.channels.delete(id);
    return ch;
  }

  delete(id: string): Channel | undefined {
    const ch = this.channels.get(id);
    if (ch) this.channels.delete(id);
    this.store.deleteChannel(id);
    return ch;
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }
}
