#!/bin/bash
# Instala claude-bridge como daemon de macOS (launchd)
# Arranca automáticamente al login, se reinicia si cae

set -e

PLIST_NAME="com.claude-bridge.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_PATH="$HOME/Library/Logs/claude-bridge.log"
BUN_PATH=$(which bun)
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$BUN_PATH" ]; then
  echo "Error: bun not found in PATH"
  exit 1
fi

# Descargar si ya estaba cargado
if launchctl list | grep -q com.claude-bridge 2>/dev/null; then
  echo "Unloading existing daemon..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-bridge</string>

  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_WATCH_REPO</key>
    <string>.</string>
    <key>BRIDGE_WATCH_PROJECT</key>
    <string>claude-bridge</string>
    <key>PATH</key>
    <string>$(dirname "$BUN_PATH"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"

echo "✅ Daemon installed: $PLIST_PATH"
echo "   Logs: $LOG_PATH"
echo "   Server: http://localhost:3456"
echo ""
echo "   To uninstall: bun run daemon:uninstall"
echo "   To view logs: bun run daemon:logs"
