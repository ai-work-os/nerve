/**
 * Decode an Ogg/Opus container into 16kHz mono Int16 LE PCM Buffer.
 * Uses prism-media which wraps either the native @discordjs/opus or pure-JS opusscript.
 *
 * Input expectation: Android client uploads Ogg-Opus chunks at 16kHz mono.
 * Output: Buffer of Int16 LE samples, ready to feed to AsrPipeline.feed(pcmInt16).
 */
import { Readable } from "node:stream";
import prism from "prism-media";

export async function decodeOpusToPcm16(opusBytes: Buffer): Promise<Buffer> {
  if (opusBytes.length === 0) return Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const inStream = Readable.from(opusBytes);
    const demux = new prism.opus.OggDemuxer();
    const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 320 });
    const chunks: Buffer[] = [];
    inStream.pipe(demux).pipe(decoder)
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}
