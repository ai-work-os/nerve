# ai-ear

**用途**：会议转录 plugin — mic/system 音频采集 → DashScope ASR → 文件 + 频道推送。

**入口**：`index.ts`（CLI + PluginBase 装配）。

**模块**：
- `audio-capture.ts` — 原生 AudioCapture 二进制封装
- `asr-client.ts` — DashScope ASR 流式客户端
- `transcript-buffer.ts` — 转录缓冲 + 按行/按间隔 flush
- `capture-pipeline.ts` — 采集 → ASR → 写出 编排

**依赖**：原生 `native/AudioCapture/AudioCapture.app`、`DASHSCOPE_API_KEY`。
