import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { PeerClient } from "../../src/peer-client.js";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    try {
      assert.equal(req.headers.authorization, "Bearer peer-token");
      assert.equal(req.url, "/peer/health");
      const parsed = JSON.parse(body);
      assert.equal(parsed.ping, true);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const client = new PeerClient({ url: `http://127.0.0.1:${address.port}`, token: "peer-token" });
    const result = await client.post("/peer/health", { ping: true });
    assert.deepEqual(result, { ok: true });
    console.log("1 passed, 0 failed");
    server.close(() => process.exit(0));
  } catch (err) {
    console.error(err);
    server.close(() => process.exit(1));
  }
});
