#!/bin/bash
# Nerve 一键启动：server + bridge + agents
# 用法: ./start.sh [--agents claude:alice,codex:bob] [--channel main]

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=${NERVE_PORT:-4800}
SOCK="${NVIM_LISTEN_ADDRESS:-}"
CHANNEL_NAME="main"
AGENTS=""
PID_FILE="$HOME/.nerve/pids"

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --agents) AGENTS="$2"; shift 2 ;;
    --channel) CHANNEL_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --sock) SOCK="$2"; shift 2 ;;
    *) shift ;;
  esac
done

mkdir -p "$HOME/.nerve"

# 检查 server 是否已运行
if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "[start] server already running on port $PORT"
else
  echo "[start] starting server on port $PORT..."
  cd "$DIR" && npx tsx src/cli.ts serve --port "$PORT" &>/dev/null &
  SERVER_PID=$!
  echo "server=$SERVER_PID" > "$PID_FILE"
  # 等 server 就绪
  for i in $(seq 1 10); do
    if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  echo "[start] server started (pid=$SERVER_PID)"
fi

# 创建频道
CHANNEL_ID=$(cd "$DIR" && npx tsx src/cli.ts channel create "$CHANNEL_NAME" 2>/dev/null)
echo "[start] channel: $CHANNEL_NAME ($CHANNEL_ID)"

# 启动 bridge（如果有 nvim socket）
if [[ -n "$SOCK" ]]; then
  echo "[start] starting bridge (sock=$SOCK)..."
  cd "$DIR" && npx tsx src/cli.ts bridge --sock "$SOCK" --channel "$CHANNEL_ID" &>/dev/null &
  BRIDGE_PID=$!
  echo "bridge=$BRIDGE_PID" >> "$PID_FILE"
  echo "[start] bridge started (pid=$BRIDGE_PID)"
else
  echo "[start] no NVIM_LISTEN_ADDRESS, skipping bridge"
fi

# 启动 agents
if [[ -n "$AGENTS" ]]; then
  IFS=',' read -ra AGENT_LIST <<< "$AGENTS"
  for entry in "${AGENT_LIST[@]}"; do
    adapter="${entry%%:*}"
    name="${entry##*:}"
    [[ "$adapter" == "$name" ]] && name="${adapter}-1"
    echo "[start] spawning $adapter as $name..."
    cd "$DIR" && npx tsx src/cli.ts node spawn "$adapter" --name "$name"
    echo "[start] joining $name to channel..."
    cd "$DIR" && npx tsx src/cli.ts node join "$name" "$CHANNEL_ID"
  done
fi

echo "[start] done. pids in $PID_FILE"
