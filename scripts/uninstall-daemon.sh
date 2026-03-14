#!/bin/bash
# Desinstala el daemon de claude-bridge

set -e

PLIST_NAME="com.claude-bridge.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$PLIST_PATH" ]; then
  echo "Daemon not installed ($PLIST_PATH not found)"
  exit 0
fi

launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "✅ Daemon uninstalled"
echo "   Plist removed: $PLIST_PATH"
