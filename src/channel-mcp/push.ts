/**
 * Pure transformer: nerve JSON-RPC notification → Claude Code channel notification payload.
 *
 * Claude Code's Channels protocol expects:
 *   { content: string, meta: Record<string,string> }
 * Meta keys must match /^[A-Za-z0-9_]+$/ (hyphens silently dropped by Claude Code).
 * Meta values are stringified.
 *
 * Returns null when the notification should not be pushed to Claude
 * (own echo, unrelated event).
 */

type Notification = { method: string; params: Record<string, unknown> };
export type ChannelEvent = { content: string; meta: Record<string, string> };

const META_KEY_RE = /^[A-Za-z0-9_]+$/;

function safeMeta(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (!META_KEY_RE.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

export function notificationToChannelEvent(
  ourNodeName: string,
  notif: Notification,
): ChannelEvent | null {
  switch (notif.method) {
    case "channel.message":
    case "channel.mention": {
      const channelId = notif.params.channelId as string | undefined;
      const channelName = notif.params.channelName as string | undefined;
      const message = notif.params.message as
        | { id?: string; from?: string; content?: string; timestamp?: number }
        | undefined;
      if (!message) return null;
      if (message.from === ourNodeName) return null; // own echo, skip
      return {
        content: String(message.content ?? ""),
        meta: safeMeta({
          event: notif.method,
          channel_id: channelId,
          channel_name: channelName,
          from_node: message.from,
          message_id: message.id,
        }),
      };
    }
    case "node.message": {
      const from = notif.params.from as string | undefined;
      const content = notif.params.content as string | undefined;
      if (from === ourNodeName) return null;
      return {
        content: String(content ?? ""),
        meta: safeMeta({
          event: "node.message",
          from_node: from,
        }),
      };
    }
    default:
      return null;
  }
}
