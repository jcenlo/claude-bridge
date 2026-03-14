#!/bin/bash
# Instala claude-bridge como daemon de macOS (launchd)
# Arranca server + named tunnel automáticamente al login

set -e

BUN_PATH=$(which bun)
CLOUDFLARED_PATH=$(which cloudflared)
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PATH="$HOME/Library/Logs/claude-bridge.log"
TUNNEL_LOG_PATH="$HOME/Library/Logs/claude-bridge-tunnel.log"

if [ -z "$BUN_PATH" ]; then
  echo "Error: bun not found in PATH"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# ---- Server plist ----

SERVER_PLIST="$HOME/Library/LaunchAgents/com.claude-bridge.plist"

if launchctl list | grep -q com.claude-bridge 2>/dev/null; then
  echo "Unloading existing server daemon..."
  launchctl unload "$SERVER_PLIST" 2>/dev/null || true
fi

cat > "$SERVER_PLIST" <<EOF
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

launchctl load "$SERVER_PLIST"
echo "✅ Server daemon installed"

# ---- Tunnel plist (only if cloudflared + config exist) ----

if [ -n "$CLOUDFLARED_PATH" ] && [ -f "$HOME/.cloudflared/config.yml" ]; then
  TUNNEL_PLIST="$HOME/Library/LaunchAgents/com.claude-bridge.tunnel.plist"

  if launchctl list | grep -q com.claude-bridge.tunnel 2>/dev/null; then
    echo "Unloading existing tunnel daemon..."
    launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  fi

  cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-bridge.tunnel</string>

  <key>ProgramArguments</key>
  <array>
    <string>${CLOUDFLARED_PATH}</string>
    <string>tunnel</string>
    <string>run</string>
    <string>claude-bridge-permanent</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${TUNNEL_LOG_PATH}</string>

  <key>StandardErrorPath</key>
  <string>${TUNNEL_LOG_PATH}</string>
</dict>
</plist>
EOF

  launchctl load "$TUNNEL_PLIST"
  echo "✅ Tunnel daemon installed (named tunnel → mcp.jcenlo.com)"
else
  echo "⏭  Tunnel skipped (cloudflared or ~/.cloudflared/config.yml not found)"
fi

echo ""
echo "   Server: http://localhost:3456"
echo "   Tunnel: https://mcp.jcenlo.com"
echo "   Logs:   $LOG_PATH"
echo ""
echo "   bun run daemon:logs      # tail server logs"
echo "   bun run daemon:uninstall # remove both daemons"
