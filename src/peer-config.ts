import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";

export interface PeerEntry {
  url: string;
  token: string;
}

export interface PeerConfig {
  name?: string;
  token?: string;
  peers: Record<string, PeerEntry>;
}

export function defaultPeerConfigPath(): string {
  return join(homedir(), ".nerve", "peers.json");
}

export function loadPeerConfig(path = process.env.NERVE_PEERS_FILE || defaultPeerConfigPath()): PeerConfig {
  if (!existsSync(path)) return { peers: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PeerConfig>;
  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    token: typeof raw.token === "string" ? raw.token : undefined,
    peers: raw.peers && typeof raw.peers === "object" ? raw.peers as Record<string, PeerEntry> : {},
  };
}

export function isLocalRequest(address?: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function hasValidToken(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, expected?: string): boolean {
  if (!expected) return false;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth === `Bearer ${expected}`) return true;
  const token = headers["x-nerve-token"];
  return token === expected;
}
