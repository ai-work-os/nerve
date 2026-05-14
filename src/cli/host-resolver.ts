/**
 * Host alias resolution for nerve CLI.
 *
 * Priority (highest wins):
 *   1. -H/--host CLI flag
 *   2. NERVE_HOST env (alias name) or NERVE_URL env (raw URL)
 *   3. Default: http://localhost:4800
 *
 * The value can be:
 *   - A full URL (starts with "http://" or "https://") → used as-is.
 *   - A "host:port" string → prefixed with "http://".
 *   - A bare hostname → prefixed with "http://" and ":4800" appended.
 *   - An alias key → looked up in ~/.config/nerve/hosts.json.
 *
 * Example ~/.config/nerve/hosts.json:
 *   {
 *     "home":  "http://100.75.43.90:4800",
 *     "local": "http://localhost:4800",
 *     "dev":   "http://localhost:4801"
 *   }
 *
 * Special key "default" in the file is used when no host is specified anywhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_URL = "http://localhost:4800";
const HOSTS_PATH = resolve(homedir(), ".config/nerve/hosts.json");

let cachedHosts: Record<string, string> | null = null;

export function loadHosts(): Record<string, string> {
  if (cachedHosts) return cachedHosts;
  if (!existsSync(HOSTS_PATH)) {
    cachedHosts = {};
    return cachedHosts;
  }
  try {
    const content = readFileSync(HOSTS_PATH, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      cachedHosts = parsed as Record<string, string>;
      return cachedHosts;
    }
  } catch {
    // fall through: malformed file → empty map (don't crash CLI)
  }
  cachedHosts = {};
  return cachedHosts;
}

/** Convert a host token (URL, host:port, hostname, or alias) into a full URL. */
export function resolveHost(token: string | undefined): string {
  if (!token) {
    // No explicit flag → check env, then "default" alias, then DEFAULT_URL
    if (process.env.NERVE_HOST) return resolveHost(process.env.NERVE_HOST);
    if (process.env.NERVE_URL) return process.env.NERVE_URL;
    const hosts = loadHosts();
    if (hosts.default) return resolveHost(hosts.default);
    return DEFAULT_URL;
  }
  // Already a URL
  if (token.startsWith("http://") || token.startsWith("https://")) return token;
  // Alias lookup
  const hosts = loadHosts();
  if (hosts[token]) return resolveHost(hosts[token]);
  // host:port
  if (/^[a-zA-Z0-9.\-_]+:\d+$/.test(token)) return `http://${token}`;
  // bare hostname or IP — append default port
  if (/^[a-zA-Z0-9.\-_]+$/.test(token)) return `http://${token}:4800`;
  throw new Error(`cannot resolve host: ${token} (not a URL, not in hosts.json)`);
}

/** Extract -H/--host from argv. Mutates argv to remove the flag.
 *  Returns the resolved URL, or undefined if no flag was present. */
export function extractHostFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-H" || argv[i] === "--host") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${argv[i]} requires a value`);
      argv.splice(i, 2);
      return resolveHost(value);
    }
  }
  return undefined;
}

/** Extract --human / --json flags. Mutates argv. Returns mode (default "json"). */
export function extractOutputFlag(argv: string[]): "json" | "human" {
  let mode: "json" | "human" = "json";
  for (let i = 0; i < argv.length;) {
    if (argv[i] === "--human") { mode = "human"; argv.splice(i, 1); continue; }
    if (argv[i] === "--json") { mode = "json"; argv.splice(i, 1); continue; }
    i++;
  }
  return mode;
}

/** Reset caches — useful for tests. */
export function resetHostCache(): void {
  cachedHosts = null;
}

export { HOSTS_PATH };
