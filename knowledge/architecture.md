# architecture

MCP server que actúa como puente de contexto compartido entre Claude.ai y Claude Code.
Ambas interfaces leen y escriben archivos .md estructurados via MCP tools.

## Arquitectura dual: local + cloud

El sistema tiene dos modos de ejecución con la misma API:

### Local (Bun) — `src/index.ts`
- Runtime: Bun con TypeScript directo
- Storage: bun:sqlite para metadata, filesystem para .md
- MCP: WebStandardStreamableHTTPServerTransport del SDK
- Multi-session: Map de transports, uno por cliente
- Watcher: Chokidar vigila src/, regenera snapshots en cada cambio
- Git hook: post-commit.sh llama a POST /snapshot
- Auth: OAuth 2.1 in-memory (tokens en Map), localhost sin auth

### Cloud (Cloudflare Workers) — `src/worker.ts`
- Runtime: Workers V8 (serverless)
- Storage: D1 (SQLite compatible) para metadata, R2 para .md
- MCP: JSON-RPC directo (sin SDK transport — Workers es stateless)
- Auth: OAuth 2.1 persistido en D1 (clients, codes, tokens)
- Sin watcher ni extractor (serverless = sin procesos persistentes)
- Recibe snapshots del watcher local via POST /snapshot

### Por qué dos entry points y no uno

Workers V8 no soporta bun:sqlite, fs, ni procesos persistentes.
El SDK transport necesita estado de sesión entre requests (Map interno),
que no sobrevive entre invocaciones de un Worker.

En vez de abstraer todo con interfaces (over-engineering para v1),
duplicamos los tool handlers con backends distintos:
- `server.ts` usa imports sync de storage.ts y fs
- `worker.ts` usa async D1 + R2, JSON-RPC handler propio

Los 12 MCP tools tienen la misma API en ambos modos.

## Flujo de datos

```
Claude.ai ──► Workers (D1 + R2) ◄── POST /snapshot ── Watcher local
                                                         │
Claude Code ──► Local server (bun:sqlite + fs) ◄────── Chokidar
                     │
                  Git hook ──► POST /snapshot ──► Workers (opcional)
```

El watcher local detecta cambios → extrae tipos con ctags/regex →
escribe .snap.md en filesystem Y opcionalmente pushea al Worker.

## Qué es stateless y qué mantiene estado

| Componente | Estado | Dónde vive |
|------------|--------|------------|
| Metadata (projects, sections, sync_log) | Persistente | bun:sqlite local / D1 remoto |
| Archivos .md | Persistente | filesystem local / R2 remoto |
| OAuth tokens | Persistente | Map in-memory local / D1 remoto |
| MCP sessions | Efímero | Map de transports local / no existe en Workers |
| Watcher state | Efímero | Variables en health.ts (watcherActive, lastPing) |

## D1 sobre bun:sqlite en Workers (ADR-001 adaptado)

ADR-001 dice: "SQLite para metadata, filesystem para contenido."
En Workers adaptamos esto a: D1 (SQLite compatible) para metadata, R2 para contenido.

El principio se mantiene: nunca duplicar contenido .md en la DB.
La diferencia: los .md en R2 no son versionables con git directamente.
El repo local sigue siendo la fuente de verdad — R2 es un mirror para Claude.ai.

## Extractor: cadena de fallback

Universal Ctags → ast-grep → regex. Solo corre local (no en Workers).
El regex fallback cubre: export interface/type/enum/class/function/const arrow.
Los paths en snapshots son relativos via path.relative(cwd, filePath).
