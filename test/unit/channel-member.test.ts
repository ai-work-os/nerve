import { strict as assert } from "node:assert";
import { parseMentions } from "../../src/router.js";
import { parseRemoteMemberName, remoteMemberId } from "../../src/channel-member.js";

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

test("parseMentions supports peer:node names", () => {
  assert.deepEqual(parseMentions("@home:bob ping @alice"), ["home:bob", "alice"]);
});

test("parseRemoteMemberName accepts peer:node only", () => {
  assert.deepEqual(parseRemoteMemberName("home:bob"), { peer: "home", nodeName: "bob" });
  assert.equal(parseRemoteMemberName("bob"), null);
  assert.equal(parseRemoteMemberName("home:"), null);
});

test("remoteMemberId is stable and explicit", () => {
  assert.equal(remoteMemberId("home", "bob"), "remote:home:bob");
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
