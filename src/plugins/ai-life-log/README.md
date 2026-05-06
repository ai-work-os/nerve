# ai-life-log

被动 24/7 麦克风转录节点。本地推理（sherpa-onnx + sensevoice-small），
按本地天滚动追加到 `~/.nerve/plugins/ai-life-log/log/YYYY-MM-DD.txt`。

## 命令

- `pause` — 暂停录音
- `resume` — 恢复录音
- `status` — 当前状态 + 今日累计

## 模型

启动时按以下顺序查找 SenseVoice：

1. `$AI_LIFE_LOG_MODEL_DIR`
2. `~/Library/Application Support/Shandianshuo/models/sensevoice-small/`
3. `~/.nerve/plugins/ai-life-log/models/sensevoice-small/`

silero_vad.onnx 默认从 `~/.nerve/plugins/ai-life-log/models/silero_vad.onnx`
读取，可用 `$AI_LIFE_LOG_VAD_MODEL` 覆盖。

下载 silero-vad：
```
curl -L -o ~/.nerve/plugins/ai-life-log/models/silero_vad.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
```

模型缺失时节点不崩溃，进入 `error: model not found` 的 idle 状态。

## 平台

仅 macOS（依赖 ai-ear 共用的 Swift `AudioCapture` 二进制）。
