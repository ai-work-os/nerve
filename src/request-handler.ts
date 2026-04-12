import { resolve } from "node:path";
import type { ChannelManager } from "./channel-manager.js";

export interface RequestContext {
  callerNodeId?: string;
}

export type RequestResult =
  | { ok: true; data: unknown }
  | { ok: false; code: number; message: string };

/**
 * Handle JSON-RPC requests as pure logic (no WebSocket dependency).
 * Returns null for methods not handled here (caller should fallback).
 */
export function handleRpcRequest(
  cm: ChannelManager,
  method: string,
  params: Record<string, unknown>,
  ctx: RequestContext,
): RequestResult | null {
  switch (method) {
    case "channel.create": {
      const cwd = resolve((params.cwd as string) || process.cwd());
      const ch = cm.createChannel(cwd, params.name as string);
      return { ok: true, data: { channelId: ch.id, name: ch.name, cwd: ch.cwd } };
    }

    case "channel.close": {
      cm.closeChannel(params.channelId as string);
      return { ok: true, data: { ok: true } };
    }

    case "channel.delete": {
      const channelId = params.channelId as string;
      if (!channelId) return { ok: false, code: -32602, message: "channelId required" };
      cm.deleteChannel(channelId);
      return { ok: true, data: { ok: true } };
    }

    case "channel.list": {
      let channelList = cm.listChannels();
      const cwdFilter = params.cwd ? resolve(params.cwd as string) : undefined;
      if (cwdFilter) {
        channelList = channelList.filter(ch => ch.cwd === cwdFilter || ch.cwd.startsWith(cwdFilter + "/"));
      }
      const channels = channelList.map(ch => ({
        id: ch.id,
        name: ch.name,
        cwd: ch.cwd,
        nodes: Object.fromEntries(ch.nodes),
      }));
      return { ok: true, data: { channels } };
    }

    case "channel.history": {
      const msgs = cm.getHistory(
        params.channelId as string,
        params.limit as number,
        params.before as number,
      );
      return { ok: true, data: { messages: msgs } };
    }

    case "node.list": {
      let nodes = cm.nodePool.listAll();
      const cwdFilter = params.cwd ? resolve(params.cwd as string) : undefined;
      if (cwdFilter) {
        nodes = nodes.filter(n =>
          n.capabilities.includes("monitor") ||
          n.cwd === cwdFilter ||
          (n.cwd && n.cwd.startsWith(cwdFilter + "/"))
        );
      }
      return { ok: true, data: { nodes: nodes.map(n => n.toInfo()) } };
    }

    case "node.updates": {
      // Returns assembled Message history (role user/agent). Program node logs are not included.
      const nodeName = params.nodeName as string;
      if (!nodeName) return { ok: false, code: -32602, message: "nodeName required" };
      const messages = cm.getNodeUpdates(nodeName);
      return { ok: true, data: { messages } };
    }

    case "blob.get": {
      const blobId = params.blobId as string;
      if (!blobId) return { ok: false, code: -32602, message: "blobId required" };
      const content = cm.blobStore.get(blobId);
      if (content) return { ok: true, data: { content } };
      return { ok: false, code: -32602, message: "blob not found" };
    }

    default:
      return null;
  }
}
