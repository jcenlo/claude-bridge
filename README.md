# claude-bridge

MCP server that syncs context between Claude.ai and Claude Code.
Both interfaces connect to the same server and read/write structured `.md` files
that live in your project repo. No more copy-pasting context between conversations.

## The problem

You design something in Claude.ai, then open Claude Code to implement it — but Code
doesn't know what you discussed. You implement something in Code, switch back to
Claude.ai — it has no idea what changed. This bridge eliminates that gap.

## Architecture

```
Claude.ai ──► Cloudflare Worker (D1 + R2) ◄── POST /snapshot ── Local watcher
                                                                    │
Claude Code ──► Local Bun server (SQLite + fs) ◄───────────── Chokidar + Git hooks
```

**Local mode** (`src/index.ts`): Bun server with bun:sqlite, filesystem, Chokidar watcher.
Claude Code connects here directly via `http://localhost:3456`.

**Cloud mode** (`src/worker.ts`): Cloudflare Worker with D1 (SQLite), R2 (object storage),
stateless JSON-RPC. Claude.ai connects here via OAuth 2.1 + PKCE.

Both expose the same 12 MCP tools. The local watcher detects code changes, extracts
types/interfaces with ctags, and pushes snapshots to the Worker.

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Universal Ctags](https://ctags.io) (optional — regex fallback if missing)
- A [Cloudflare](https://cloudflare.com) account (free tier, only for Claude.ai access)

## Quick start (local only — 5 minutes)

```bash
# 1. Clone and install
git clone https://github.com/jcenlo/claude-bridge.git
cd claude-bridge
bun install

# 2. Start the server
bun run dev
# → http://localhost:3456

# 3. Connect Claude Code (one-time, global)
claude mcp add --transport http claude-bridge http://localhost:3456
```

Claude Code now calls `session_init` automatically at the start of every conversation.

## Deploy to Cloudflare Workers (for Claude.ai)

The local server only accepts connections from localhost. To connect Claude.ai,
deploy to Cloudflare Workers — gives you a permanent HTTPS URL with no tunnel needed.

```bash
# 1. Install Wrangler and log in
bun add -d wrangler
bunx wrangler login

# 2. Create D1 database and R2 bucket
bunx wrangler d1 create claude-bridge-db
bunx wrangler r2 bucket create claude-bridge-kb

# 3. Update wrangler.toml with the database_id from step 2

# 4. Apply migrations and deploy
bunx wrangler d1 migrations apply claude-bridge-db --remote
bunx wrangler deploy
# → https://claude-bridge.<your-subdomain>.workers.dev
```

Then connect Claude.ai:
1. Go to **Settings → Integrations → Add custom connector**
2. Paste `https://claude-bridge.<your-subdomain>.workers.dev/mcp`
3. Claude.ai will run the OAuth flow automatically (auto-approve, no password)

### Sync local knowledge to the Worker

```bash
# Upload your .md files to R2 so Claude.ai can read them
for file in knowledge/*.md; do
  bunx wrangler r2 object put \
    "claude-bridge-kb/my-project/$(basename $file)" \
    --file "$file" --remote
done
```

## Use with an existing project

```bash
# 1. Bootstrap — scans your code and generates the knowledge base
bun scripts/bootstrap.ts --repo /path/to/project --project my-project

# 2. Install git hooks — auto-updates snapshots on each commit
bun scripts/setup-hooks.ts /path/to/project

# 3. Copy config to your project root and edit it
cp .claude-bridge /path/to/project/.claude-bridge
```

Edit `.claude-bridge` to match your directory structure:

```yaml
project: my-project
mcp_server: http://localhost:3456
knowledge_path: ./knowledge
watcher:
  watch: ./src
  extensions: [.ts, .tsx, .sql, .prisma]
  section_mapping:
    src/db:         database
    src/api:        api
    src/auth:       auth
    src/components: frontend
    src/services:   services
```

The bootstrap generates:
- `knowledge/INDEX.md` — section map with status tracking and heartbeat
- `knowledge/{section}.snap.md` — extracted types, interfaces, function signatures
- `knowledge/{section}.md` — placeholder for narrative context (you fill this in)

## MCP tools

| Tool | Description |
|------|-------------|
| `session_init` | Auto-called at conversation start. Returns relevant context for the topic. |
| `get_context` | Read narrative (the "why") for a section |
| `get_snapshot` | Read auto-generated code snapshot (types, signatures) |
| `save_context` | Write narrative with optimistic locking |
| `save_snapshot` | Write code artifacts (Claude Code only) |
| `update_index` | Change section status/summary in INDEX.md |
| `list_sections` | List all sections with status |
| `list_projects` | List registered projects |
| `search` | Full-text search across knowledge base |
| `delete_context` | Archive or delete a section |
| `kb_reset` | Reset sections after major refactors |
| `get_health` | Server and watcher health status |

## Knowledge base structure

```
/knowledge/
  INDEX.md              ← always read first — section map + heartbeat
  architecture.md       ← narrative: decisions, trade-offs, relationships
  architecture.snap.md  ← auto-generated: real types and function signatures
  database.md
  database.snap.md
  decisions.md          ← ADRs — never auto-generated, never deleted
```

Narrative files (`.md`) are written by Claude or by you.
Snapshot files (`.snap.md`) are auto-generated by the extractor — never edit them manually.

## Scripts

```bash
bun run dev          # local server with hot reload
bun run bootstrap    # generate initial KB for a project
bun run setup        # install git hooks in a project
bun run cleanup      # weekly stale section cleanup (--dry-run to preview)
bunx wrangler deploy # deploy changes to Cloudflare Workers
```

## Contributing

1. Read `docs/SPEC.md` for the full specification
2. Read `docs/DECISIONS.md` for architecture decision records (8 ADRs)
3. The knowledge base in `knowledge/` has up-to-date narrative context
4. Run `bun run check` before committing (Biome: single quotes, 2-space indent, no semicolons)
5. The git hook auto-generates snapshots on each commit

Stack: Bun, TypeScript, MCP SDK, SQLite (bun:sqlite / D1), Chokidar, Cloudflare Workers (D1 + R2).
