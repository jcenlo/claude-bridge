#!/bin/sh
# Git post-commit hook — regenera snapshots cuando cambia código relevante
# Instalado por: bun run setup (en el repo cliente, no en claude-bridge)

# Solo actúa si existe .claude-bridge en el repo
if [ ! -f ".claude-bridge" ]; then
  exit 0
fi

# Lee el mcp_server del .claude-bridge
MCP_SERVER=$(grep 'mcp_server:' .claude-bridge | sed 's/mcp_server: //' | tr -d ' ')
if [ -z "$MCP_SERVER" ]; then
  MCP_SERVER="http://localhost:3456"
fi

# Lee el nombre del proyecto
PROJECT=$(grep '^project:' .claude-bridge | sed 's/project: //' | tr -d ' ')
if [ -z "$PROJECT" ]; then
  exit 0
fi

# Obtiene archivos cambiados en el último commit
CHANGED=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null)

# Filtra por extensiones relevantes
RELEVANT=$(echo "$CHANGED" | grep -E '\.(ts|tsx|sql|prisma|env\.example)$')

if [ -z "$RELEVANT" ]; then
  exit 0
fi

echo "[claude-bridge] Updating snapshots for changed files..."

# Llama al endpoint del MCP server via curl para triggerear snapshot
# El server detecta los archivos y actualiza los .snap.md correspondientes
PAYLOAD=$(printf '{"project":"%s","files":%s}' "$PROJECT" "$(echo "$RELEVANT" | jq -R -s -c 'split("\n") | map(select(length > 0))')")

curl -s -X POST "$MCP_SERVER/snapshot" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

# Actualiza last_sync en INDEX.md directamente (no depende del server)
KNOWLEDGE_PATH=$(grep 'knowledge_path:' .claude-bridge | sed 's/knowledge_path: //' | tr -d ' ')
INDEX_FILE="${KNOWLEDGE_PATH}/INDEX.md"

if [ -f "$INDEX_FILE" ]; then
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  # sed -i compatible con macOS y Linux
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s/^> last_sync: .*/> last_sync: $NOW/" "$INDEX_FILE"
  else
    sed -i "s/^> last_sync: .*/> last_sync: $NOW/" "$INDEX_FILE"
  fi
  git add "$INDEX_FILE" > /dev/null 2>&1 || true
fi

echo "[claude-bridge] Done."
