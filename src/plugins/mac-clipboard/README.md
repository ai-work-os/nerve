# mac-clipboard plugin

Runs on a Mac, connects to a nerve server (local or remote over tailscale), subscribes to `#screenshots`, and for each screenshot: downloads the blob, saves it to `~/Screenshots/from-phone/`, copies it to the Mac clipboard, then acks delivery. On reconnect it drains any screenshots missed while the Mac was asleep.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NERVE_HOST` | `127.0.0.1` | nerve WS host |
| `NERVE_PORT` | `4800` | nerve WS port |
| `SCREENSHOT_HTTP_URL` | `http://<NERVE_HOST>:4812` | screenshot plugin HTTP base URL |
| `SCREENSHOT_CHANNEL` | `screenshots` | channel name to subscribe to |
| `MAC_INBOX_DIR` | `~/Screenshots/from-phone` | directory to save screenshots |

## Manual start

```bash
cd ~/work/worktree/ai-work-os/nerve
NERVE_HOST=100.75.43.90 NERVE_PORT=4800 SCREENSHOT_HTTP_URL=http://100.75.43.90:4812 \
  npx tsx src/plugins/mac-clipboard/index.ts
```

## launchd setup (auto-start on login)

1. Copy and fill in the template:

```bash
REPO=~/work/worktree/ai-work-os/nerve
NPX=$(which npx)
NERVE_HOST=100.75.43.90

sed \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__NPX__|$NPX|g" \
  -e "s|__NERVE_HOST__|$NERVE_HOST|g" \
  -e "s|__NERVE_PORT__|4800|g" \
  -e "s|__SCREENSHOT_HTTP_URL__|http://$NERVE_HOST:4812|g" \
  "$REPO/src/plugins/mac-clipboard/com.nerve.mac-clipboard.plist.template" \
  > ~/Library/LaunchAgents/com.nerve.mac-clipboard.plist
```

2. Load the job:

```bash
launchctl load ~/Library/LaunchAgents/com.nerve.mac-clipboard.plist
```

3. Check status:

```bash
launchctl list | grep nerve
tail -f ~/work/worktree/ai-work-os/nerve/.mac-clipboard.log
```

4. Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.nerve.mac-clipboard.plist
```
