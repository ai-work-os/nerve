# Blob-delivery seam

How a producer plugin (today: `screenshot`) hands large binary payloads
through nerve to a consumer plugin (today: `mac-clipboard`), out-of-band
from the channel message that announces them.

> This doc names a real seam: two adapters already exist (a server inside
> `screenshot/http-server.ts`, a client inside `mac-clipboard/blob-client.ts`).
> Calling it "blob-delivery" prevents the next plugin that needs the same
> shape from inventing a third name or copy-pasting the client.

## Why a separate seam (not just channel messages)

Channel messages are routed through nerve's WebSocket layer and persisted in
SQLite. Putting multi-megabyte image bytes through that path would:

1. bloat the channel-history database (binary payloads next to text),
2. inflate every WS broadcast (each member would receive the bytes even if
   they don't need them),
3. lose content-addressing dedup (identical images = identical channel
   messages, but each one stored fresh).

So bytes go over HTTP, only a **reference** (`blob=<sha256>`) is posted to
the channel. Consumers see the reference, decide if they want the bytes, and
pull on demand.

## Contract

A blob-delivery **producer** is a plugin that:

1. Runs an HTTP server on a known port (today: `SCREENSHOT_HTTP_PORT`,
   default 4812). Bind address is `0.0.0.0` so a tailscale-reachable nerve
   exposes it across the mesh.
2. Posts a reference message to a channel when a new blob lands. The
   reference must include `blob=<id>` so consumers can parse it. (Today's
   format: `📷 screenshot | blob=<sha256> | source=<x> | analyze=<bool>` —
   see `mac-clipboard/message-parser.ts`.)
3. Exposes four endpoints:

   | Method | Path                            | Purpose                             |
   |--------|---------------------------------|-------------------------------------|
   | POST   | `/<kind>/upload`                | Ingest raw bytes (producer-driven). |
   | GET    | `/<kind>/blob/:id`              | Fetch raw bytes by content id.      |
   | GET    | `/<kind>/pending-<consumer>`    | List blobs the consumer hasn't acked. |
   | POST   | `/<kind>/ack-<consumer>`        | Mark a blob as delivered.           |

   `<kind>` is the producer's slug (`screenshot`). `<consumer>` is the
   downstream's slug (`mac`). One producer can support multiple consumers
   by exposing `pending-<a>` / `ack-<a>` per consumer.

A blob-delivery **consumer** is a plugin that:

1. Subscribes to the producer's announce channel.
2. On each announce message, parses out `blob=<id>` and pulls via
   `GET /<kind>/blob/:id`.
3. On (re)connect, drains `GET /<kind>/pending-<consumer>` so an offline
   consumer catches up — paired with **persistent: true**
   (see [node-resilience.md](./node-resilience.md)) on the consumer node so
   that being offline doesn't drop it from the channel.
4. After processing, calls `POST /<kind>/ack-<consumer>` with the blobId.

## Today's adapters

**Producer** — `screenshot` plugin:

- Server: `src/plugins/screenshot/http-server.ts` (`ScreenshotHttpServer`)
- Storage: `src/plugins/screenshot/screenshot-store.ts` (`ScreenshotStore`) —
  content-addressed (sha256) blobs + per-consumer delivery tracking.
  See [its module-level docstring](../../src/plugins/screenshot/screenshot-store.ts).
- Plugin entry: `src/plugins/screenshot/index.ts`.

**Consumer** — `mac-clipboard` plugin:

- Client: `src/plugins/mac-clipboard/blob-client.ts` —
  `downloadBlob` / `fetchPendingMac` / `ackMac`.
- Message parser: `src/plugins/mac-clipboard/message-parser.ts` —
  decodes `blob=<id>` out of the channel announce text.
- Plugin entry: `src/plugins/mac-clipboard/index.ts`.

## Composition with NodeResilience

The blob-delivery seam assumes the consumer may be offline at any moment
(sleeping Mac, dead VPN). Pairing the consumer node with
`persistent: true` (Layer 2 of [NodeResilience](./node-resilience.md))
means:

- consumer disappears from the WS but stays in the channel,
- producer's `pending-<consumer>` list keeps growing,
- when the consumer wakes and reconnects, it sees the announces it missed
  (via channel-history replay) **and** drains `pending-<consumer>` to be
  doubly sure.

Both paths converge through the same idempotent `processed` set inside the
consumer (`mac-clipboard/index.ts: this.processed`).

## Where future blob-delivery features go

Anything matching "producer hands binary payloads to consumer" lives here:

- **Other producers** — e.g. an `ai-voice` plugin emitting recorded audio
  clips. Should expose the same four endpoints under its own `<kind>`.
- **Other consumers** — e.g. an Android-side blob fetcher. Should reuse the
  client shape (`downloadBlob` / `fetchPending` / `ack`).
- **Garbage collection** — `ScreenshotStore.prune()` exists but no policy is
  defined. Decide here, not per-plugin.
- **Auth** — today the HTTP server is wide open behind the tailscale mesh;
  if we ever expose it publicly the auth contract lives at this seam.

## Non-goals

- This seam is **HTTP over the same machine or tailscale mesh**, not a
  generic CDN. Cross-host federation is a different concern.
- This seam carries **binary payloads with content addresses**, not arbitrary
  RPC. Smaller structured data should go through channel messages or nerve
  JSON-RPC.
- This seam is **not yet abstracted into shared code**. If a third producer
  arrives, extract; until then, two adapters at the same seam is fine. Naming
  it is enough.
