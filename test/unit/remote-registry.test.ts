import { strict as assert } from "node:assert";
import { RemoteRegistry } from "../../src/remote-registry.js";

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

test("registerRemoteMember stores proxy mapping", () => {
  const reg = new RemoteRegistry();
  reg.registerRemoteMember({ localChannelId: "ch1", remoteChannelId: "home-ch", peer: "home", remoteNode: "bob" });
  assert.deepEqual(reg.getRemoteMember("home:bob"), {
    localName: "home:bob",
    localId: "remote:home:bob",
    localChannelId: "ch1",
    remoteChannelId: "home-ch",
    peer: "home",
    remoteNode: "bob",
  });
});

test("registerRemoteOrigin maps remote reply to origin", () => {
  const reg = new RemoteRegistry();
  reg.registerRemoteOrigin({ localChannelId: "home-ch", originPeer: "mac", originChannelId: "mac-ch", localNode: "bob" });
  assert.deepEqual(reg.getRemoteOrigin("home-ch", "bob"), {
    localChannelId: "home-ch",
    originPeer: "mac",
    originChannelId: "mac-ch",
    localNode: "bob",
  });
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
