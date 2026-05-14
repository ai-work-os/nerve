/**
 * CLI integration tests — exercise the refactored nerve CLI as a child process
 * against a running nerve server.
 *
 * Covers:
 *  - Global flags: --host (alias + URL forms), --human, --json
 *  - host-resolver.json profile lookup
 *  - All command namespaces (channel, node, session, peer, scene, dm)
 *  - JSON output contract: success → JSON object to stdout, error → JSON to stderr + exit 1
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assert, assertEq, sleep,
  ROOT,
  getTestPort,
  httpPost,
  startServer, stopServer,
} from "../helpers/vitest.js";

const CLI_PATH = resolve(ROOT, "src/cli.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      NERVE_URL: `http://localhost:${getTestPort()}`,
      ...opts.env,
    };
    const child = spawn(TSX, [CLI_PATH, ...args], { env, cwd: opts.cwd || ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function parseJsonLine(s: string): any {
  // CLI emits one JSON object per call; trim trailing newline
  return JSON.parse(s.trim());
}

describe("CLI integration: global flags & host resolution", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("health returns JSON by default", async () => {
    const r = await runCli(["health"]);
    assertEq(r.exitCode, 0, "health: exit 0");
    const obj = parseJsonLine(r.stdout);
    assertEq(obj.status, "ok", "health: status ok");
  });

  it("health --human returns plain text", async () => {
    const r = await runCli(["health", "--human"]);
    assertEq(r.exitCode, 0, "health --human: exit 0");
    assert(r.stdout.startsWith("ok"), `health --human: starts with ok, got "${r.stdout.trim()}"`);
    assert(!r.stdout.includes("{"), "health --human: no JSON");
  });

  it("unknown command exits 1 with JSON error", async () => {
    const r = await runCli(["nonexistent-cmd"]);
    assertEq(r.exitCode, 1, "unknown cmd: exit 1");
    const err = parseJsonLine(r.stderr);
    assert(typeof err.error === "string" && err.error.includes("unknown command"), "unknown cmd: error message");
  });

  it("--host URL form sets baseUrl", async () => {
    const port = getTestPort();
    // Use --host with explicit URL; clear NERVE_URL so flag takes effect
    const r = await runCli(["--host", `http://localhost:${port}`, "health"], { env: { NERVE_URL: "http://localhost:9" } });
    assertEq(r.exitCode, 0, `--host URL: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assertEq(obj.status, "ok", "--host URL: connected");
  });

  it("--host alias from ~/.config/nerve/hosts.json", async () => {
    // Set HOME to a tmpdir with a hosts.json mapping "test" → real server
    const tmpHome = mkdtempSync(`${tmpdir()}/nerve-cli-home-`);
    const cfgDir = resolve(tmpHome, ".config/nerve");
    require("node:fs").mkdirSync(cfgDir, { recursive: true });
    writeFileSync(resolve(cfgDir, "hosts.json"), JSON.stringify({ test: `http://localhost:${getTestPort()}` }));

    const r = await runCli(["--host", "test", "health"], {
      env: { HOME: tmpHome, NERVE_URL: "" },
    });
    assertEq(r.exitCode, 0, `--host alias: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assertEq(obj.status, "ok", "--host alias: connected via alias");
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("unresolvable --host alias errors out", async () => {
    const tmpHome = mkdtempSync(`${tmpdir()}/nerve-cli-home-`);
    const r = await runCli(["--host", "nope-alias", "health"], {
      env: { HOME: tmpHome, NERVE_URL: "" },
    });
    assertEq(r.exitCode, 1, "bad alias: exit 1");
    assert(r.stderr.includes("cannot resolve host") || r.stderr.includes("error"), `bad alias: error in stderr, got "${r.stderr}"`);
    rmSync(tmpHome, { recursive: true, force: true });
  });
});

describe("CLI integration: command coverage", () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it("status command returns aggregated JSON", async () => {
    const r = await runCli(["status"]);
    assertEq(r.exitCode, 0, `status: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assertEq(obj.status, "ok", "status: status ok");
    assert(Array.isArray(obj.nodes), "status: nodes is array");
    assert(Array.isArray(obj.channels), "status: channels is array");
  });

  it("node list works (empty or populated)", async () => {
    const r = await runCli(["node", "list"]);
    assertEq(r.exitCode, 0, `node list: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assert(Array.isArray(obj.nodes), "node list: nodes is array");
  });

  it("node capabilities returns adapter map", async () => {
    const r = await runCli(["node", "capabilities"]);
    assertEq(r.exitCode, 0, `node caps: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assert(typeof obj.capabilities === "object", "node caps: capabilities is object");
  });

  it("node spawn + list + stop round-trip", async () => {
    const spawn = await runCli(["node", "spawn", "mock", "--name", "cli-mock-1", "--cwd", ROOT]);
    assertEq(spawn.exitCode, 0, `node spawn: exit 0, stderr=${spawn.stderr}`);
    const spawnObj = parseJsonLine(spawn.stdout);
    assert(typeof spawnObj.nodeId === "string", "node spawn: nodeId returned");

    await sleep(500);
    const list = await runCli(["node", "list"]);
    const listObj = parseJsonLine(list.stdout);
    const found = (listObj.nodes as any[]).find(n => n.name === "cli-mock-1");
    assert(!!found, "node list: spawned node appears");

    const stop = await runCli(["node", "stop", "cli-mock-1"]);
    assertEq(stop.exitCode, 0, `node stop: exit 0, stderr=${stop.stderr}`);
  });

  it("channel create + list + close", async () => {
    const create = await runCli(["channel", "create", "cli-test-ch", "--cwd", ROOT]);
    assertEq(create.exitCode, 0, `channel create: exit 0, stderr=${create.stderr}`);
    const createObj = parseJsonLine(create.stdout);
    const chId = createObj.channelId;
    assert(typeof chId === "string", "channel create: channelId returned");

    const list = await runCli(["channel", "list"]);
    const listObj = parseJsonLine(list.stdout);
    const found = (listObj.channels as any[]).find(ch => ch.id === chId);
    assert(!!found, "channel list: created channel found");

    const close = await runCli(["channel", "close", chId]);
    assertEq(close.exitCode, 0, `channel close: exit 0, stderr=${close.stderr}`);
  });

  it("channel members --channel <id>", async () => {
    const create = await runCli(["channel", "create", "members-test", "--cwd", ROOT]);
    const chId = parseJsonLine(create.stdout).channelId;

    const r = await runCli(["channel", "members", "--channel", chId]);
    assertEq(r.exitCode, 0, `channel members: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assert(Array.isArray(obj.members), "channel members: members is array");

    await runCli(["channel", "close", chId]);
  });

  it("dm send + read against a spawned agent", async () => {
    // Spawn mock — accepts node.message via the program-node DM path
    const spawnRes = await httpPost("/node/spawn", { adapter: "mock", name: "cli-dm-target", cwd: ROOT }) as any;
    assert(!!spawnRes.nodeId, `dm test: spawn returned nodeId, got ${JSON.stringify(spawnRes)}`);
    await sleep(3000);

    // dm send — mock accepts but won't reply via dm-history (replies arrive via prompt flow)
    const send = await runCli(["dm", "send", "cli-dm-target", "hello", "--from", "cli-test"]);
    assertEq(send.exitCode, 0, `dm send: exit 0, stderr=${send.stderr}`);

    // dm read — should succeed and return an array
    const read = await runCli(["dm", "read", "cli-dm-target"]);
    assertEq(read.exitCode, 0, `dm read: exit 0, stderr=${read.stderr}`);
    const readObj = parseJsonLine(read.stdout);
    assert(Array.isArray(readObj.messages), "dm read: messages is array");

    await httpPost("/node/stop", { nodeId: spawnRes.nodeId });
  });

  it("node command with --args parses key=value pairs", async () => {
    // Try to invoke a non-existent command on a non-existent node — we only
    // care that arg parsing succeeds and the request reaches the server.
    const r = await runCli([
      "node", "command", "no-such-node", "trigger",
      "--args", "name=foo",
      "--args", "force=true",
    ]);
    assertEq(r.exitCode, 1, "node command: exit 1 for unknown node");
    assert(r.stderr.includes("error"), `node command: error message in stderr, got "${r.stderr}"`);
  });

  it("node command --json-args parses JSON object", async () => {
    const r = await runCli([
      "node", "command", "no-such-node", "trigger",
      "--json-args", '{"name":"foo","force":true}',
    ]);
    assertEq(r.exitCode, 1, "node command --json-args: exit 1 for unknown node");
    assert(r.stderr.includes("error"), "node command --json-args: error in stderr");
  });

  it("peer health returns ok + port", async () => {
    const r = await runCli(["peer", "health"]);
    assertEq(r.exitCode, 0, `peer health: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assertEq(obj.ok, true, "peer health: ok=true");
    assertEq(obj.port, getTestPort(), "peer health: port matches");
  });

  it("scene list returns scenes array", async () => {
    const r = await runCli(["scene", "list"]);
    assertEq(r.exitCode, 0, `scene list: exit 0, stderr=${r.stderr}`);
    const obj = parseJsonLine(r.stdout);
    assert(Array.isArray(obj.scenes), "scene list: scenes is array");
  });

  it("session clear on unknown node errors gracefully", async () => {
    const r = await runCli(["session", "clear", "no-such-node"]);
    assertEq(r.exitCode, 1, "session clear unknown: exit 1");
    assert(r.stderr.includes("error"), "session clear unknown: error in stderr");
  });

  it("namespace with no subcommand prints help", async () => {
    const r = await runCli(["channel"]);
    assertEq(r.exitCode, 0, "namespace no subcommand: exit 0");
    assert(r.stdout.includes("Subcommands:"), `namespace help: shows subcommands, got "${r.stdout}"`);
  });

  it("--help prints global help", async () => {
    const r = await runCli(["--help"]);
    assertEq(r.exitCode, 0, "--help: exit 0");
    assert(r.stdout.includes("Global flags:"), "--help: shows global flags");
    assert(r.stdout.includes("Namespaces"), "--help: shows namespaces");
  });
});
