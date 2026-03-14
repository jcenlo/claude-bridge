# PROJECT: claude-bridge
> stack: Bun, TypeScript, MCP SDK, SQLite (bun:sqlite/D1), Chokidar, Cloudflare Workers, D1, R2, Wrangler
> status: active
> last_sync: 2026-03-14T13:04:02Z

## sections

| id | file | status | last_updated | summary |
|----|------|--------|--------------|---------|
| architecture | /knowledge/architecture | stable | 2026-03-14 | Dual arch: local Bun + Cloudflare Workers |
| database | /knowledge/database | stable | 2026-03-14 | bun:sqlite local, D1 remote, same schema |
| decisions | /knowledge/decisions | frozen | 2026-03-14 | 8 ADRs: storage, runtime, knowledge layers, auth |
| workers | /knowledge/workers | stable | 2026-03-14 | CF Worker: JSON-RPC, D1 auth, R2 files |

## active
working-on: Cloudflare Workers deployment, cleanup.ts, narrativa KB
