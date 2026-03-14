#!/bin/bash
# Desinstala los daemons de claude-bridge (server + tunnel)

set -e

SERVER_PLIST="$HOME/Library/LaunchAgents/com.claude-bridge.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/com.claude-bridge.tunnel.plist"

for PLIST in "$SERVER_PLIST" "$TUNNEL_PLIST"; do
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ Removed: $(basename "$PLIST")"
  fi
done

echo "   Daemons uninstalled"
