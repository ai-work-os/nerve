/**
 * MappingStore — feishu_chat_id ↔ nerve channel + agent，JSON 文件持久化。
 * 原子写：tmp → rename。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatMapping {
  feishuChatId: string;
  channelId: string;
  agentName: string;
  createdAt: string;
}

export class MappingStore {
  private path: string;
  private entries = new Map<string, ChatMapping>();
  /** Optional logger for parse errors (so silent data loss is observable) */
  private log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void = () => {}) {
    this.path = path;
    this.log = log;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const arr = JSON.parse(raw) as ChatMapping[];
      for (const m of arr) {
        this.entries.set(m.feishuChatId, m);
      }
    } catch (err: any) {
      // 文件坏掉：日志告警，备份后重置以避免静默丢数据
      const msg = `mapping file corrupt at ${this.path}: ${err?.message || err}`;
      this.log(msg);
      try { renameSync(this.path, this.path + ".corrupt." + Date.now()); } catch {}
    }
  }

  get(feishuChatId: string): ChatMapping | undefined {
    return this.entries.get(feishuChatId);
  }

  all(): ChatMapping[] {
    return [...this.entries.values()];
  }

  async set(m: ChatMapping): Promise<void> {
    this.entries.set(m.feishuChatId, m);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path);
  }
}
