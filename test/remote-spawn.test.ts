import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.cwd();
const MAC_PORT = 4920;
const HOME_PORT = 4921;
const macData = mkdtempSync(join(tmpdir(), "nerve-mac-"));
const homeData = mkdtempSync(join(tmpdir(), "nerve-home-"));
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
  const spawned = await post(MAC_PORT, "/remote/spawn", {
    peer: "home",
    adapter: "mock",
    name: "bob",
    channelId: ch.channelId,
    cwd: ROOT,
  });

  assert.equal(spawned.name, "home:bob");
  const macChannels = await post(MAC_PORT, "/channel/list", {});
  const macChannel = macChannels.channels.find((c: any) => c.id === ch.channelId);
  assert(macChannel.nodes["home:bob"], "Mac channel has remote proxy");

  const homeNodes = await post(HOME_PORT, "/node/list", {});
  assert(homeNodes.nodes.some((n: any) => n.name === "bob"), "home spawned bob");

  console.log("3 passed, 0 failed");
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
