import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeOpusToPcm16 } from "../../src/plugins/ai-life-log/opus-decoder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("opus decoder", () => {
  it("解码已知 .opus fixture 得到合理长度的 PCM", async () => {
    // fixture：1 秒 16kHz mono opus 文件，由 ffmpeg 离线生成
    const fixturePath = join(__dirname, "../fixtures/lifelog/1s_16k_mono.opus");
    const opusBytes = readFileSync(fixturePath);
    const pcm = await decodeOpusToPcm16(opusBytes);
    // 1 秒 16kHz 16-bit mono = 32000 字节，宽容 ±5%（codec 边界）
    expect(pcm.length).toBeGreaterThan(30000);
    expect(pcm.length).toBeLessThan(34000);
  });

  it("空 buffer 返回空 PCM", async () => {
    const pcm = await decodeOpusToPcm16(Buffer.alloc(0));
    expect(pcm.length).toBe(0);
  });
});
