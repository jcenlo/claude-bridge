# workers

Cloudflare Workers deployment de claude-bridge.
URL permanente: https://claude-bridge.round-night-11dc.workers.dev

## src/worker.ts — entry point

Worker entry point que reemplaza src/index.ts para producción.
Un solo archivo (~450 líneas) con todo: routing, auth, MCP handler, tool implementations.

### Por qué JSON-RPC directo (sin SDK transport)

El SDK usa WebStandardStreamableHTTPServerTransport que mantiene estado de sesión
en un Map interno. En Workers, cada request puede ir a un isolate distinto —
el Map se pierde entre requests.

En vez de usar Durable Objects (complejo para v1), implementamos el protocolo
MCP directamente:
- `initialize` → devuelve capabilities (sin session ID)
- `notifications/*` → 202 Accepted
- `tools/list` → array de tool definitions con JSON Schema
- `tools/call` → dispatch al handler, respuesta SSE

Formato de respuesta: `event: message\ndata: {jsonrpc response}\n\n`
(mismo formato SSE que el SDK transport).

## Auth en D1

OAuth 2.1 con PKCE, persistido en 3 tablas D1:
- `oauth_clients` — registro dinámico (RFC 7591)
- `oauth_codes` — códigos de autorización (TTL 5 min)
- `oauth_tokens` — access tokens (TTL 24h)

Flujo: register → authorize (auto-approve) → token exchange → Bearer en /mcp.
La auth local usa Maps in-memory (src/auth.ts). La auth Workers usa D1 (inline en worker.ts).

## Storage: D1 + R2

- D1 (SQLite compatible): projects, sections, sync_log — mismo schema que bun:sqlite
- R2 (object storage): archivos .md con key format `{projectId}/{filename}`
- storage-d1.ts: mismo API que storage.ts pero async y recibe D1Database como param

## Deploy

```bash
bunx wrangler login         # una vez
bunx wrangler deploy        # desplegar cambios
bunx wrangler d1 migrations apply claude-bridge-db --remote  # migraciones
bunx wrangler r2 object put "claude-bridge-kb/{project}/{file}" --file path --remote
```

## Limitaciones Workers vs Local

| Feature | Local | Workers |
|---------|-------|---------|
| Watcher (Chokidar) | Si | No (serverless) |
| Extractor (ctags) | Si | No (sin shell) |
| MCP sessions | Multi-session | Stateless |
| Hot reload | bun --watch | wrangler deploy |
