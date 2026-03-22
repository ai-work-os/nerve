#!/bin/bash
set -e

if [[ "$(uname)" == "Darwin" ]]; then
    launchctl unload ~/Library/LaunchAgents/com.nerve.server.plist 2>/dev/null || true
    echo "nerve stopped via launchd"
else
    sudo systemctl stop nerve
    echo "nerve stopped via systemd"
fi
