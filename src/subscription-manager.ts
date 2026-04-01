import { WebSocket } from "ws";

/**
 * Manages direct node subscriptions (node.subscribe / node.unsubscribe).
 * Subscribers receive real-time node.update and node.statusChanged notifications.
 */
export class SubscriptionManager {
  // nodeId → Set<WebSocket>
  private nodeSubscribers = new Map<string, Set<WebSocket>>();

  /** Subscribe a WebSocket to a node's updates. Replays existing buffer. */
  subscribe(
    ws: WebSocket,
    nodeId: string,
    node: { id: string; name: string; updateBuffer: Record<string, unknown>[] },
  ): void {
    if (!this.nodeSubscribers.has(nodeId)) {
      this.nodeSubscribers.set(nodeId, new Set());
    }
    this.nodeSubscribers.get(nodeId)!.add(ws);

    // Replay existing buffer to subscriber
    if (node.updateBuffer.length > 0) {
      for (const update of node.updateBuffer) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "node.update",
          params: { nodeId: node.id, name: node.name, ...update },
        }));
      }
    }
  }

  /** Unsubscribe a WebSocket from a node's updates. */
  unsubscribe(ws: WebSocket, nodeId: string): void {
    const subs = this.nodeSubscribers.get(nodeId);
    if (subs) subs.delete(ws);
  }

  /** Remove all subscriptions for a node (e.g. when node stops). */
  removeNode(nodeId: string): void {
    this.nodeSubscribers.delete(nodeId);
  }

  /** Remove a WebSocket from all subscriptions (e.g. on disconnect). */
  removeSubscriber(ws: WebSocket): void {
    for (const [, subs] of this.nodeSubscribers) {
      subs.delete(ws);
    }
  }

  /** Notify direct subscribers of a node's events. */
  notify(
    nodeId: string,
    event: string,
    node: { id: string; name: string; status: string; activity?: string },
    detail?: Record<string, unknown>,
    excludeWs?: WebSocket,
  ): void {
    const subs = this.nodeSubscribers.get(nodeId);
    if (!subs || subs.size === 0) return;

    let notification: Record<string, unknown>;
    if (event === "node.update") {
      notification = {
        jsonrpc: "2.0",
        method: "node.update",
        params: { nodeId: node.id, name: node.name, ...(detail || {}) },
      };
    } else {
      notification = {
        jsonrpc: "2.0",
        method: "node.statusChanged",
        params: { nodeId: node.id, name: node.name, status: node.status, activity: node.activity },
      };
    }

    const msg = JSON.stringify(notification);
    for (const ws of subs) {
      if (ws === excludeWs) continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
