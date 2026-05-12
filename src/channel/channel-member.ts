export interface RemoteMemberRef {
  peer: string;
  nodeName: string;
}

export function parseRemoteMemberName(name: string): RemoteMemberRef | null {
  const match = name.match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  return { peer: match[1], nodeName: match[2] };
}

export function remoteMemberName(peer: string, nodeName: string): string {
  return `${peer}:${nodeName}`;
}

export function remoteMemberId(peer: string, nodeName: string): string {
  return `remote:${peer}:${nodeName}`;
}

export function isRemoteMemberId(nodeId: string): boolean {
  return nodeId.startsWith("remote:");
}
