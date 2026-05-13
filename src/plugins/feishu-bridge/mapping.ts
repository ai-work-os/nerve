/**
 * MappingStore — feishu_chat_id ↔ nerve channel/agent + bridge-level preferences.
 *
 * Disk format v2:
 *   { "version": 2, "defaultAdapter": "codex", "mappings": [ ChatMapping... ] }
 *
 * Legacy v1 (bare array) is migrated on first read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatMapping {
  feishuChatId: string;
  channelId: string;
  agentName: string;
  /** Which adapter was used to spawn the agent. Added in v2; defaults "codex". */
  agentAdapter?: string;
  createdAt: string;
}

interface DiskV2 {
  version: 2;
  defaultAdapter: string;
  mappings: ChatMapping[];
}

const DEFAULT_ADAPTER_FALLBACK = "codex";

export class MappingStore {
  private path: string;
  private entries = new Map<string, ChatMapping>();
  private defaultAdapter = DEFAULT_ADAPTER_FALLBACK;
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
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // v1 → v2 migration: bare array of mappings, no defaultAdapter
        for (const m of parsed as ChatMapping[]) {
          if (m && m.feishuChatId) this.entries.set(m.feishuChatId, m);
        }
        this.log(`mapping store: migrated v1 (${this.entries.size} entries) → v2`);
        return;
      }
      const obj = parsed as DiskV2;
      if (typeof obj.defaultAdapter === "string" && obj.defaultAdapter) {
        this.defaultAdapter = obj.defaultAdapter;
      }
      for (const m of obj.mappings || []) {
        if (m && m.feishuChatId) this.entries.set(m.feishuChatId, m);
      }
    } catch (err: any) {
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

  getDefaultAdapter(): string {
    return this.defaultAdapter;
  }

  async setDefaultAdapter(name: string): Promise<void> {
    this.defaultAdapter = name;
    await this.persist();
  }

  async set(m: ChatMapping): Promise<void> {
    this.entries.set(m.feishuChatId, m);
    await this.persist();
  }

  async delete(feishuChatId: string): Promise<boolean> {
    const had = this.entries.delete(feishuChatId);
    if (had) await this.persist();
    return had;
  }

  async clearAll(): Promise<number> {
    const count = this.entries.size;
    this.entries.clear();
    await this.persist();
    return count;
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: DiskV2 = {
      version: 2,
      defaultAdapter: this.defaultAdapter,
      mappings: this.all(),
    };
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, this.path);
  }
}
