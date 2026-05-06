# ai-life-log

被动 24/7 麦克风转录节点。本地推理（sherpa-onnx + sensevoice-small），
按本地天滚动追加到 `~/.nerve/plugins/ai-life-log/log/YYYY-MM-DD.txt`。

## 命令

- `pause` — 暂停录音
- `resume` — 恢复录音
- `status` — 当前状态 + 今日累计

## 模型

需要两个本地模型文件：sherpa-onnx 官方 SenseVoice + silero-vad。

### SenseVoice

启动时按以下顺序查找包含 `model.onnx` 与 `tokens.txt`（或 `tokens.json`）的目录：

1. `$AI_LIFE_LOG_MODEL_DIR`
2. `~/Library/Application Support/Shandianshuo/models/sensevoice-small/`（闪电说预置目录）
3. `~/.nerve/plugins/ai-life-log/models/sensevoice-small/`（推荐：sherpa-onnx 官方模型）

注意：闪电说 0.6.x 自带的 `model.onnx` 元数据不完整（缺 `vocab_size`），
不能直接被 sherpa-onnx 1.13.0 加载。**推荐下载 sherpa-onnx 官方 int8 版本**：

```bash
mkdir -p ~/.nerve/plugins/ai-life-log/models/sensevoice-small
cd ~/.nerve/plugins/ai-life-log/models/sensevoice-small
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar xjf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2 --strip-components=1
rm sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
```

### silero-vad

```bash
curl -L -o ~/.nerve/plugins/ai-life-log/models/silero_vad.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
```

可用 `$AI_LIFE_LOG_VAD_MODEL` 覆盖路径。

模型缺失或格式不符时节点不崩溃，进入 `error: ...` 的 idle 状态。

## 平台

仅 macOS（依赖 ai-ear 共用的 Swift `AudioCapture` 二进制）。
