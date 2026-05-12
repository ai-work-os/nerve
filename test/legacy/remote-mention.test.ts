import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.cwd();
const MAC_PORT = 4922;
const HOME_PORT = 4923;
const macData = mkdtempSync(join(tmpdir(), "nerve-mac-mention-"));
const homeData = mkdtempSync(join(tmpdir(), "nerve-home-mention-"));
let macProc: ChildProcess | undefined;
let homeProc: ChildProcess | undefined;

async function post(port: number, path: string, body: object): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function waitHealth(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server ${port} did not start`);
}

function startServer(port: number, dataDir: string, peerFile: string): ChildProcess {
  return spawn("npx", ["tsx", "src/index.ts", "--port", String(port), "--data", dataDir], {
    cwd: ROOT,
    env: { ...process.env, NERVE_PEERS_FILE: peerFile },
    stdio: "ignore",
  });
}

async function waitFor(fn: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const macPeers = join(macData, "peers.json");
  const homePeers = join(homeData, "peers.json");
  writeFileSync(macPeers, JSON.stringify({
    name: "mac",
    token: "mac-token",
    peers: { home: { url: `http://127.0.0.1:${HOME_PORT}`, token: "home-token" } },
  }));
  writeFileSync(homePeers, JSON.stringify({
    name: "home",
    token: "home-token",
    peers: { mac: { url: `http://127.0.0.1:${MAC_PORT}`, token: "mac-token" } },
  }));

  macProc = startServer(MAC_PORT, macData, macPeers);
  homeProc = startServer(HOME_PORT, homeData, homePeers);
  await Promise.all([waitHealth(MAC_PORT), waitHealth(HOME_PORT)]);

  const ch = await post(MAC_PORT, "/channel/create", { name: "mac-main", cwd: ROOT });
  await post(MAC_PORT, "/remote/spawn", {
    peer: "home",
    adapter: "mock",
    name: "bob",
    channelId: ch.channelId,
    cwd: ROOT,
  });
  await waitFor(async () => {
    const nodes = await post(HOME_PORT, "/node/list", {});
    return nodes.nodes.some((n: any) => n.name === "bob" && n.status === "idle");
  }, "home bob ready");
  await post(MAC_PORT, "/channel/post", { channelId: ch.channelId, from: "renjinxi", content: "@home:bob ping" });

  await waitFor(async () => {
    const channels = await post(HOME_PORT, "/channel/list", {});
    const remote = channels.channels.find((c: any) => c.name?.startsWith("remote:mac:"));
    if (!remote) return false;
    const history = await post(HOME_PORT, "/channel/history", { channelId: remote.id, limit: 20 });
    return history.messages.some((m: any) => m.from === "bob" && m.content.includes("@main mock回复"));
  }, "home bob remote prompt reply");

  console.log("1 passed, 0 failed");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  macProc?.kill();
  homeProc?.kill();
  rmSync(macData, { recursive: true, force: true });
  rmSync(homeData, { recursive: true, force: true });
});
