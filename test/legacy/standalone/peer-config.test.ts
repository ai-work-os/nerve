import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPeerConfig, isLocalRequest, hasValidToken } from "../../../src/transport/peer-config.js";

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    fail++;
  }
}

test("loadPeerConfig reads peers and server token", () => {
  const dir = mkdtempSync(join(tmpdir(), "nerve-peer-"));
  const file = join(dir, "peers.json");
  writeFileSync(file, JSON.stringify({
    name: "mac",
    token: "local-token",
    peers: { home: { url: "http://10.0.0.2:4800", token: "home-token" } },
  }));

  const config = loadPeerConfig(file);

  assert.equal(config.name, "mac");
  assert.equal(config.token, "local-token");
  assert.equal(config.peers.home.url, "http://10.0.0.2:4800");
  assert.equal(config.peers.home.token, "home-token");
});

test("isLocalRequest accepts loopback addresses only", () => {
  assert.equal(isLocalRequest("127.0.0.1"), true);
  assert.equal(isLocalRequest("::1"), true);
  assert.equal(isLocalRequest("::ffff:127.0.0.1"), true);
  assert.equal(isLocalRequest("10.8.0.5"), false);
});

test("hasValidToken accepts bearer and X-Nerve-Token", () => {
  assert.equal(hasValidToken({ authorization: "Bearer abc" }, "abc"), true);
  assert.equal(hasValidToken({ "x-nerve-token": "abc" }, "abc"), true);
  assert.equal(hasValidToken({ authorization: "Bearer wrong" }, "abc"), false);
  assert.equal(hasValidToken({}, "abc"), false);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
