#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Building AudioCapture..."
swift build -c release 2>&1

BINARY=".build/release/AudioCapture"
if [ -f "$BINARY" ]; then
    echo "Build successful: $BINARY"
    ls -lh "$BINARY"
else
    echo "Build failed: binary not found"
    exit 1
fi
