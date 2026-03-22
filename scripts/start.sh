#!/bin/bash
set -e

if [[ "$(uname)" == "Darwin" ]]; then
    launchctl load ~/Library/LaunchAgents/com.nerve.server.plist 2>/dev/null || true
    echo "nerve started via launchd"
else
    sudo systemctl start nerve
    echo "nerve started via systemd"
fi
