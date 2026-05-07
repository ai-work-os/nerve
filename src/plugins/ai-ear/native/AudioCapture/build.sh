#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Building AudioCapture..."
swift build -c release 2>&1

BINARY=".build/release/AudioCapture"
if [ ! -f "$BINARY" ]; then
    echo "Build failed: binary not found"
    exit 1
fi
echo "Build successful: $BINARY"
ls -lh "$BINARY"

# Wrap into a .app bundle so macOS TCC can prompt for / remember mic permission.
# Without this, launchd-spawned children inherit launchd's TCC context and the
# system silently denies microphone access. Bundle id stays stable across rebuilds.
APP=".build/release/AudioCapture.app"
echo "Wrapping into $APP..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BINARY" "$APP/Contents/MacOS/AudioCapture"
cp AudioCapture.app.Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --deep "$APP" 2>&1
echo "Bundle: $APP"
