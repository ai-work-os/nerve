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
#
# Idempotent: only rebuild + re-sign when the source binary changed. Keeping the
# inner binary identical means cdhash stays the same → previously granted TCC
# permission survives rebuilds (without this, every `swift build` invalidates the
# user's mic grant).
APP=".build/release/AudioCapture.app"
APP_BIN="$APP/Contents/MacOS/AudioCapture"
SRC_HASH=$(shasum "$BINARY" | awk '{print $1}')
APP_HASH=$(shasum "$APP_BIN" 2>/dev/null | awk '{print $1}')
if [ -d "$APP" ] && [ "$SRC_HASH" = "$APP_HASH" ]; then
  echo "Bundle up-to-date (source binary unchanged): $APP"
else
  echo "Wrapping into $APP..."
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cp "$BINARY" "$APP_BIN"
  cp AudioCapture.app.Info.plist "$APP/Contents/Info.plist"
  codesign --force --sign - --deep "$APP" 2>&1
  echo "Bundle: $APP (NOTE: TCC permission may need to be re-granted after rebuild)"
fi
