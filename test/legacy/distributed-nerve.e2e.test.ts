import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = process.cwd();
const MAC_PORT = 4930;
const HOME_PORT = 4931;
const macData = mkdtempSync(join(tmpdir(), "nerve-e2e-mac-"));
const homeData = mkdtempSync(join(tmpdir(), "nerve-e2e-home-"));
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
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitNodeIdle(port: number, name: string): Promise<void> {
  await waitFor(async () => {
    const nodes = await post(port, "/node/list", {});
    return nodes.nodes.some((n: any) => n.name === name && n.status === "idle");
  }, `${name} idle on ${port}`);
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

  const macCh = await post(MAC_PORT, "/channel/create", { name: "mac-main", cwd: ROOT });
  const homeCh = await post(HOME_PORT, "/channel/create", { name: "home-main", cwd: ROOT });

  await post(MAC_PORT, "/remote/spawn", {
    peer: "home",
    adapter: "mock",
    name: "bob",
    channelId: macCh.channelId,
    cwd: ROOT,
  });
  await post(HOME_PORT, "/remote/spawn", {
    peer: "mac",
    adapter: "mock",
    name: "alice",
    channelId: homeCh.channelId,
    cwd: ROOT,
  });

  await Promise.all([
    waitNodeIdle(HOME_PORT, "bob"),
    waitNodeIdle(MAC_PORT, "alice"),
  ]);

  await post(MAC_PORT, "/channel/post", { channelId: macCh.channelId, from: "renjinxi", content: "@home:bob ping from mac" });
  await post(HOME_PORT, "/channel/post", { channelId: homeCh.channelId, from: "renjinxi", content: "@mac:alice ping from home" });

  await waitFor(async () => {
    const history = await post(MAC_PORT, "/channel/history", { channelId: macCh.channelId, limit: 30 });
    return history.messages.some((m: any) => m.from === "home:bob" && m.content.includes("mock回复"));
  }, "home:bob reply in Mac channel");

  await waitFor(async () => {
    const history = await post(HOME_PORT, "/channel/history", { channelId: homeCh.channelId, limit: 30 });
    return history.messages.some((m: any) => m.from === "mac:alice" && m.content.includes("mock回复"));
  }, "mac:alice reply in home channel");

  console.log("2 passed, 0 failed");
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
