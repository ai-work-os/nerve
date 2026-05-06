import { remoteMemberId, remoteMemberName } from "./channel-member.js";

export interface RemoteMemberRecord {
  localName: string;
  localId: string;
  localChannelId: string;
  remoteChannelId: string;
  peer: string;
  remoteNode: string;
}

export interface RemoteOriginRecord {
  localChannelId: string;
  originPeer: string;
  originChannelId: string;
  localNode: string;
}

export class RemoteRegistry {
  private members = new Map<string, RemoteMemberRecord>();
  private origins = new Map<string, RemoteOriginRecord>();

  registerRemoteMember(input: { localChannelId: string; remoteChannelId: string; peer: string; remoteNode: string }): RemoteMemberRecord {
    const localName = remoteMemberName(input.peer, input.remoteNode);
    const record: RemoteMemberRecord = {
      localName,
      localId: remoteMemberId(input.peer, input.remoteNode),
      localChannelId: input.localChannelId,
      remoteChannelId: input.remoteChannelId,
      peer: input.peer,
      remoteNode: input.remoteNode,
    };
    this.members.set(localName, record);
    return record;
  }

  getRemoteMember(localName: string): RemoteMemberRecord | undefined {
    return this.members.get(localName);
  }

  registerRemoteOrigin(input: RemoteOriginRecord): void {
    this.origins.set(`${input.localChannelId}:${input.localNode}`, input);
  }

  getRemoteOrigin(localChannelId: string, localNode: string): RemoteOriginRecord | undefined {
    return this.origins.get(`${localChannelId}:${localNode}`);
  }
}
