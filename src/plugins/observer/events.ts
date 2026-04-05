/**
 * Observer event formatting — converts raw nerve notifications into structured JSONL events.
 */

export interface ObserverEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

function now(): string {
  return new Date().toISOString();
}

/** Format a channel.message notification into an ObserverEvent */
export function formatChannelMessage(params: any): ObserverEvent {
  const msg = params.message ?? params;
  return {
    ts: now(),
    type: "channel.message",
    ch: params.channelId,
    chName: params.channelName,
    from: msg.from,
    fromType: msg.metadata?.nodeType,
    content: msg.content,
  };
}

/** Format a node.registered broadcast into an ObserverEvent */
export function formatNodeRegistered(params: any): ObserverEvent {
  return {
    ts: now(),
    type: "node.registered",
    node: params.name,
    adapter: params.adapter,
    transport: params.transport,
  };
}

/** Format a node.stopped broadcast into an ObserverEvent */
export function formatNodeStopped(params: any): ObserverEvent {
  return {
    ts: now(),
    type: "node.stopped",
    node: params.name,
    exitCode: params.exitCode ?? null,
  };
}

/** Format a node.statusChanged broadcast into an ObserverEvent */
export function formatNodeStatusChanged(params: any): ObserverEvent {
  return {
    ts: now(),
    type: "node.statusChanged",
    node: params.name,
    status: params.status,
    activity: params.activity,
  };
}
