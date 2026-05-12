import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, MessageInfo } from "../transport/protocol.js";

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        transport     TEXT NOT NULL,
        adapter       TEXT,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        permissions   TEXT NOT NULL DEFAULT 'member',
        cwd           TEXT,
        status        TEXT NOT NULL DEFAULT 'stopped',
        session_id    TEXT,
        pid           INTEGER,
        created_at    INTEGER NOT NULL,
        stopped_at    INTEGER
      );

      CREATE TABLE IF NOT EXISTS channels (
        id          TEXT PRIMARY KEY,
        name        TEXT,
        cwd         TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        closed_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS channel_nodes (
        channel_id  TEXT NOT NULL REFERENCES channels(id),
        node_id     TEXT NOT NULL REFERENCES nodes(id),
        node_name   TEXT NOT NULL,
        joined_at   INTEGER NOT NULL,
        left_at     INTEGER,
        PRIMARY KEY (channel_id, node_name)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL REFERENCES channels(id),
        from_name   TEXT NOT NULL,
        content     TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        metadata    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel
        ON messages(channel_id, timestamp);

      CREATE TABLE IF NOT EXISTS dm_messages (
        id        TEXT PRIMARY KEY,
        node_id   TEXT NOT NULL,
        role      TEXT NOT NULL,
        sender    TEXT NOT NULL,
        text      TEXT NOT NULL,
        ts        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dm_messages_node
        ON dm_messages(node_id, ts);

    `);
  }

  // --- Channel ---

  insertChannel(id: string, cwd: string, name?: string): void {
    this.db.prepare(
      "INSERT INTO channels (id, name, cwd, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, name ?? null, cwd, Date.now());
  }

  closeChannel(id: string): void {
    this.db.prepare(
      "UPDATE channels SET closed_at = ? WHERE id = ?"
    ).run(Date.now(), id);
  }

  deleteChannel(id: string): void {
    this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(id);
    this.db.prepare("DELETE FROM channel_nodes WHERE channel_id = ?").run(id);
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  listChannels(): Array<{ id: string; name: string | null; cwd: string; createdAt: number }> {
    return this.db.prepare(
      "SELECT id, name, cwd, created_at as createdAt FROM channels WHERE closed_at IS NULL"
    ).all() as any;
  }

  listArchivedChannels(activeIds: string[], cwd?: string, query?: string): Array<{
    id: string; name: string | null; cwd: string; createdAt: number;
    memberCount: number; memberNames: string | null;
    lastFrom: string | null; lastContent: string | null; lastTs: number | null;
    agents: Array<{ name: string; adapter: string | null; cwd: string | null; sessionId: string | null }>;
  }> {
    const excludePlaceholders = activeIds.length > 0
      ? activeIds.map(() => "?").join(",")
      : "'__none__'";

    let sql = `
      SELECT c.id, c.name, c.cwd, c.created_at as createdAt,
        (SELECT COUNT(DISTINCT node_name) FROM channel_nodes WHERE channel_id = c.id) as memberCount,
        (SELECT GROUP_CONCAT(DISTINCT node_name) FROM channel_nodes WHERE channel_id = c.id) as memberNames,
        m.from_name as lastFrom, m.content as lastContent, m.timestamp as lastTs
      FROM channels c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE channel_id = c.id ORDER BY timestamp DESC LIMIT 1
      )
      WHERE c.id NOT IN (${excludePlaceholders})
    `;
    const params: unknown[] = [...activeIds];

    if (cwd) {
      sql += ` AND (c.cwd = ? OR c.cwd LIKE ? || '/%')`;
      params.push(cwd, cwd);
    }
    if (query) {
      sql += ` AND c.name LIKE ?`;
      params.push(`%${query}%`);
    }
    sql += ` ORDER BY COALESCE(m.timestamp, c.created_at) DESC LIMIT 50`;

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map(row => {
      const agents = this.db.prepare(`
        SELECT DISTINCT cn.node_name as name, n.adapter, n.cwd, n.session_id as sessionId
        FROM channel_nodes cn
        JOIN nodes n ON n.id = cn.node_id
        WHERE cn.channel_id = ? AND n.transport = 'stdio'
      `).all(row.id) as any[];
      return { ...row, agents };
    });
  }

  getChannelForRestore(channelId: string): { id: string; name: string | null; cwd: string; createdAt: number } | undefined {
    return this.db.prepare(
      "SELECT id, name, cwd, created_at as createdAt FROM channels WHERE id = ?"
    ).get(channelId) as any;
  }

  getChannelAgents(channelId: string): Array<{ name: string; adapter: string | null; cwd: string | null; sessionId: string | null }> {
    return this.db.prepare(`
      SELECT DISTINCT cn.node_name as name, n.adapter, n.cwd, n.session_id as sessionId
      FROM channel_nodes cn
      JOIN nodes n ON n.id = cn.node_id
      WHERE cn.channel_id = ? AND n.transport = 'stdio'
    `).all(channelId) as any[];
  }

  // --- Node ---

  insertNode(id: string, name: string, transport: string, adapter?: string, capabilities?: string[], cwd?: string): void {
    this.db.prepare(
      "INSERT INTO nodes (id, name, transport, adapter, capabilities, cwd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'connecting', ?)"
    ).run(id, name, transport, adapter ?? null, JSON.stringify(capabilities ?? []), cwd ?? null, Date.now());
  }

  updateNodeStatus(id: string, status: string, sessionId?: string, pid?: number): void {
    this.db.prepare(
      "UPDATE nodes SET status = ?, session_id = COALESCE(?, session_id), pid = COALESCE(?, pid), stopped_at = CASE WHEN ? = 'stopped' THEN ? ELSE stopped_at END WHERE id = ?"
    ).run(status, sessionId ?? null, pid ?? null, status, Date.now(), id);
  }

  markAllNodesStopped(): void {
    this.db.prepare(
      "UPDATE nodes SET status = 'stopped', stopped_at = ? WHERE status != 'stopped'"
    ).run(Date.now());
  }

  markAllChannelNodesLeft(): void {
    this.db.prepare(
      "UPDATE channel_nodes SET left_at = ? WHERE left_at IS NULL"
    ).run(Date.now());
  }

  // --- Channel-Node ---

  addNodeToChannel(channelId: string, nodeId: string, nodeName: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO channel_nodes (channel_id, node_id, node_name, joined_at) VALUES (?, ?, ?, ?)"
    ).run(channelId, nodeId, nodeName, Date.now());
  }

  removeNodeFromChannel(channelId: string, nodeName: string): void {
    this.db.prepare(
      "UPDATE channel_nodes SET left_at = ? WHERE channel_id = ? AND node_name = ? AND left_at IS NULL"
    ).run(Date.now(), channelId, nodeName);
  }

  getChannelNodes(channelId: string): Array<{ nodeId: string; nodeName: string }> {
    return this.db.prepare(
      "SELECT node_id as nodeId, node_name as nodeName FROM channel_nodes WHERE channel_id = ? AND left_at IS NULL"
    ).all(channelId) as any;
  }

  // --- Message ---

  insertMessage(msg: MessageInfo): void {
    this.db.prepare(
      "INSERT INTO messages (id, channel_id, from_name, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(msg.id, msg.channelId, msg.from, msg.content, msg.timestamp, msg.metadata ? JSON.stringify(msg.metadata) : null);
  }

  getMessages(channelId: string, limit = 50, before?: number): MessageInfo[] {
    const rows = before
      ? this.db.prepare(
          "SELECT id, channel_id as channelId, from_name as 'from', content, timestamp, metadata FROM messages WHERE channel_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?"
        ).all(channelId, before, limit)
      : this.db.prepare(
          "SELECT id, channel_id as channelId, from_name as 'from', content, timestamp, metadata FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?"
        ).all(channelId, limit);

    return (rows as any[]).reverse().map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  insertDmMessage(msg: Message): void {
    this.db.prepare(
      "INSERT INTO dm_messages (id, node_id, role, sender, text, ts) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(msg.id, msg.nodeId, msg.role, msg.sender, msg.text, msg.ts);
  }

  getDmMessages(nodeId: string, limit = 50, before?: number): Message[] {
    const rows = before
      ? this.db.prepare(
          "SELECT id, node_id as nodeId, role, sender, text, ts FROM dm_messages WHERE node_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?"
        ).all(nodeId, before, limit)
      : this.db.prepare(
          "SELECT id, node_id as nodeId, role, sender, text, ts FROM dm_messages WHERE node_id = ? ORDER BY ts DESC LIMIT ?"
        ).all(nodeId, limit);

    return (rows as Message[]).reverse();
  }

  close(): void {
    this.db.close();
  }
}
