/**
 * User Recorder — pure logic functions (no side effects, easily testable).
 *
 * Filters and stores messages from client nodes (TUI, Android, Web).
 * Client nodes have nodeType === "websocket" in channel.message metadata.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface UserMessage {
  ts: string;
  channelId: string;
  from: string;
  content: string;
}

export interface SessionSummary {
  channelId: string;
  messages: UserMessage[];
}

/**
 * Should we record this message?
 * Only messages from client nodes (nodeType === "websocket") are recorded.
 * AI agents are "stdio", plugins are "program".
 */
export function shouldRecord(metadata: any): boolean {
  return metadata?.nodeType === "websocket";
}

/**
 * Extract a UserMessage from channel.message notification params.
 * Handles both nested (params.message.from) and flat (params.from) formats.
 */
export function formatRecord(params: any): UserMessage {
  const msg = params.message ?? params;
  return {
    ts: new Date().toISOString(),
    channelId: params.channelId,
    from: msg.from,
    content: msg.content,
  };
}

/**
 * Generate a file-safe session key from channelId.
 */
export function sessionKey(channelId: string): string {
  return channelId;
}

/**
 * Read all messages from a session file.
 * Returns empty array if file doesn't exist. Skips corrupted lines.
 */
export function readSessionMessages(sessionsDir: string, channelId: string): UserMessage[] {
  const filePath = resolve(sessionsDir, `${sessionKey(channelId)}.jsonl`);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, "utf-8").split("\n");
  const messages: UserMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // skip corrupted lines
    }
  }
  return messages;
}

/**
 * Get all sessions that have messages on a given date (YYYY-MM-DD).
 * Scans all session files and filters messages by date prefix in timestamp.
 */
export function getSessionsForDate(sessionsDir: string, date: string): SessionSummary[] {
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  const results: SessionSummary[] = [];

  for (const file of files) {
    const channelId = file.replace(/\.jsonl$/, "");
    const allMessages = readSessionMessages(sessionsDir, channelId);
    const dateMessages = allMessages.filter(m => m.ts.startsWith(date));
    if (dateMessages.length > 0) {
      results.push({ channelId, messages: dateMessages });
    }
  }

  return results;
}

/**
 * Format status output: total messages and session count.
 */
export function formatStatusReport(sessionsDir: string): string {
  if (!existsSync(sessionsDir)) return "0 messages, 0 sessions";

  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  let totalMessages = 0;

  for (const file of files) {
    const channelId = file.replace(/\.jsonl$/, "");
    const messages = readSessionMessages(sessionsDir, channelId);
    totalMessages += messages.length;
  }

  return `${totalMessages} messages, ${files.length} sessions`;
}

/**
 * Format a date report: which sessions had messages on that date, and how many.
 */
export function formatDateReport(sessionsDir: string, date: string): string {
  const sessions = getSessionsForDate(sessionsDir, date);

  if (sessions.length === 0) {
    return `# User Messages Report: ${date}\n\nNo sessions found for ${date}.`;
  }

  const lines = [`# User Messages Report: ${date}\n`];
  let total = 0;
  for (const s of sessions) {
    lines.push(`- **${s.channelId}**: ${s.messages.length} messages`);
    total += s.messages.length;
  }
  lines.push(`\nTotal: ${total} messages across ${sessions.length} sessions`);
  return lines.join("\n");
}
