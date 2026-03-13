# SPEC — claude-bridge

## Qué es

Un MCP server ligero que actúa como fuente única de verdad de contexto entre
Claude.ai y Claude Code. Ambas interfaces se conectan al mismo server y
leen/escriben archivos .md estructurados que viven en el repo del proyecto.

## Problema que resuelve

Cuando conceptualizas algo en Claude.ai y luego abres Claude Code, tienes que
copiar y pegar el contexto manualmente. Y al revés: cuando Claude Code implementa
algo, Claude.ai no sabe qué cambió. Este sistema elimina ese copy-paste.

---

## Arquitectura

```
Claude.ai ──────┐
                ├──► MCP Server (HTTP/SSE) ──► SQLite + archivos .md en repo
Claude Code ────┘
                          │
                    File Watcher (Chokidar)
                    Git Hooks (post-commit)
                    Code Extractor (ctags/tree-sitter)
```

### Flujo principal

1. Claude Code hace cambios en código
2. Chokidar detecta el cambio → extractor genera snapshot de tipos/interfaces
3. Git post-commit hook actualiza INDEX.md con last_sync timestamp
4. Claude.ai abre sesión nueva → llama session_init automáticamente
5. MCP lee INDEX.md → devuelve solo contexto relevante para el topic

### Modo degradado (fallbacks por capa)

| Capa falla        | Fallback                              |
|-------------------|---------------------------------------|
| MCP server caído  | Claude Code lee INDEX.md local        |
| Watcher falla     | Git hook lo suple en cada commit      |
| ClaudeSync falla  | Copia manual de /knowledge a Projects |
| Todo falla        | CLAUDE.md funciona como siempre       |

---

## Knowledge Base structure

Los archivos viven en `/knowledge/` dentro del repo del proyecto cliente.
El MCP server los lee y escribe desde ahí.

```
/knowledge/
  INDEX.md              ← mapa ligero, se lee siempre primero
  architecture.md       ← narrativa: stack, servicios, relaciones
  architecture.snap.md  ← snapshot: tipos e interfaces reales (auto-generado)
  database.md
  database.snap.md
  api.md
  api.snap.md
  auth.md
  decisions.md          ← ADRs, nunca auto-generado
```

### Formato INDEX.md

```markdown
# PROJECT: {nombre}
> stack: {tecnologías}
> status: active | paused | archived
> last_sync: 2026-03-13T10:32:00Z   ← heartbeat del watcher

## sections

| id           | file                    | status      | last_updated        | summary                   |
|--------------|-------------------------|-------------|---------------------|---------------------------|
| architecture | /knowledge/architecture | stable      | 2026-03-10T09:00Z   | monolito → edge services  |
| database     | /knowledge/database     | in-progress | 2026-03-13T10:30Z   | añadiendo schema de pagos |
| api          | /knowledge/api          | stable      | 2026-03-08T14:00Z   | REST v1, 23 endpoints     |
| auth         | /knowledge/auth         | frozen      | 2026-02-01T09:00Z   | JWT + RLS Supabase        |

## active
working-on: database, frontend
blocked-by: payments integration
```

### Estados de sección

| Estado      | Significado                                      |
|-------------|--------------------------------------------------|
| empty       | Existe en el índice pero sin contenido           |
| in-progress | Está cambiando activamente ahora                 |
| stable      | Al día, cambios recientes ya documentados        |
| outdated    | El código cambió después del último snapshot     |
| frozen      | No cambia, no se carga a menos que se pida       |
| stale       | Sin leer en 30 días, candidata a limpieza        |

---

## MCP Tools

### session_init
**Descripción para Claude (CRÍTICA — así se auto-trigerea):**
```
ALWAYS call this tool at the very start of ANY development conversation,
before responding to the user. Pass the main topic as a string.
Returns project context so you never need to ask the user to re-explain
the codebase.
```

**Parámetros:**
```typescript
{
  project: string      // nombre del proyecto, viene del .claude-bridge
  topic?: string       // lo que se va a trabajar: "payments", "auth", etc.
}
```

**Comportamiento según estado del proyecto:**

| Estado del KB | Modo           | Qué hace                                              |
|---------------|----------------|-------------------------------------------------------|
| Sin INDEX.md  | bootstrap      | Pregunta stack y objetivo, genera INDEX.md base        |
| KB parcial    | triage         | Devuelve contexto + lista secciones outdated           |
| KB completo   | precision      | INDEX.md + sección relevante + snapshot               |

**Returns:**
```typescript
{
  mode: 'bootstrap' | 'triage' | 'precision'
  project: string
  sync_status: 'fresh' | 'stale' | 'unknown'  // basado en last_sync
  last_sync: string                             // ISO timestamp
  index: string                                 // contenido de INDEX.md
  context?: string                              // narrativa sección relevante
  snapshot?: string                             // código real extraído
  warnings?: string[]                           // secciones outdated, etc.
}
```

---

### get_context
**Parámetros:**
```typescript
{
  project: string
  section: string    // 'database', 'api', 'auth', etc.
}
```
**Returns:** contenido de `{section}.md` (narrativa, el porqué)

---

### get_snapshot
**Parámetros:**
```typescript
{
  project: string
  section: string
}
```
**Returns:** contenido de `{section}.snap.md` (código real, tipos, firmas)
Solo Claude Code escribe snapshots. Claude.ai solo los lee.

---

### save_context
**Parámetros:**
```typescript
{
  project: string
  section: string
  content: string
  last_read_at?: string   // ISO timestamp, para optimistic locking
}
```

**Comportamiento (optimistic locking):**
- Si `last_read_at` < `last_updated` de esa sección → devuelve conflict error
- Si no hay conflicto → escribe y actualiza INDEX.md

**Returns:**
```typescript
{
  success: boolean
  conflict?: {
    your_version: string     // lo que intentabas guardar
    current_version: string  // lo que hay ahora
    last_updated: string
  }
}
```

---

### save_snapshot
Solo llamado por Claude Code, nunca manualmente.

**Parámetros:**
```typescript
{
  project: string
  section: string
  artifacts: {
    types?: string       // interfaces y tipos extraídos
    signatures?: string  // firmas de funciones exportadas
    schema?: string      // schema de DB si aplica
    env?: string         // estructura de env vars (sin valores)
  }
}
```

---

### update_index
**Parámetros:**
```typescript
{
  project: string
  section: string
  status: 'empty' | 'in-progress' | 'stable' | 'outdated' | 'frozen' | 'stale'
  summary?: string   // descripción corta (máx 60 chars)
}
```

---

### search
**Parámetros:**
```typescript
{
  project: string
  query: string
  scope?: 'narrative' | 'snapshots' | 'all'   // default: 'all'
}
```
**Returns:** array de matches con sección, fragmento y score de relevancia

---

### list_sections
**Parámetros:**
```typescript
{
  project?: string   // si no se pasa, lista todos los proyectos
}
```
**Returns:** tabla del INDEX.md como estructura JSON

---

### list_projects
Sin parámetros. Devuelve todos los proyectos registrados en el MCP server.
Usado cuando no hay `.claude-bridge` para identificar el proyecto automáticamente.

---

### delete_context
**Parámetros:**
```typescript
{
  project: string
  section: string
  archive?: boolean   // default true — guarda como {section}-archived.md
}
```

---

### kb_reset
Comando para refactors grandes.

**Parámetros:**
```typescript
{
  project: string
  sections?: string[]   // si no se pasa, resetea todo el KB
}
```

**Comportamiento:**
1. Renombra `{section}.md` → `{section}-v{n}.md` (preserva historial)
2. Marca sección como `empty` en INDEX.md
3. Claude Code puede hacer bootstrap de las secciones afectadas

---

### get_health
Sin parámetros. Devuelve estado del servidor.

**Returns:**
```typescript
{
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number
  last_sync: string
  watcher_active: boolean
  projects: number
  sections_total: number
  sections_outdated: number
}
```

---

## Storage — SQLite schema

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,   -- nombre del proyecto
  path        TEXT NOT NULL,       -- path al /knowledge del repo
  created_at  TEXT NOT NULL,
  last_sync   TEXT NOT NULL        -- heartbeat del watcher
);

CREATE TABLE sections (
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  status       TEXT NOT NULL DEFAULT 'empty',
  summary      TEXT,
  last_updated TEXT NOT NULL,
  last_read_at TEXT,
  PRIMARY KEY (id, project_id)
);

CREATE TABLE sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  action     TEXT NOT NULL,   -- 'write' | 'snapshot' | 'reset' | 'cleanup'
  source     TEXT NOT NULL,   -- 'claude_ai' | 'claude_code' | 'watcher' | 'hook'
  created_at TEXT NOT NULL
);
```

Los archivos `.md` viven en el filesystem (en el repo del proyecto).
SQLite solo guarda metadata y el sync_log. Nunca duplica contenido.

---

## File Watcher — Chokidar

Vigila el directorio `src/` del proyecto cliente.
En cada cambio significativo (`.ts`, `.tsx`, `.sql`, `.prisma`):

1. Espera `stabilityThreshold: 800ms` para evitar triggers en guardados parciales
2. Llama al extractor para el archivo modificado
3. Determina a qué sección pertenece el archivo (via `.claude-bridge` mapping)
4. Actualiza `{section}.snap.md`
5. Escribe `last_sync` en INDEX.md
6. Marca sección como `in-progress` si estaba `stable`

**Heartbeat:** cada 5 minutos escribe `last_sync` en INDEX.md aunque no haya cambios,
para confirmar que el watcher sigue vivo.

**Detección de caída:** si `now - last_sync > 30min`, `session_init` incluye
un warning: `"⚠️ watcher no responde desde hace X minutos — snapshots pueden estar desactualizados"`

---

## Code Extractor

Usa `ctags` como opción principal (200+ lenguajes, sin config).
Fallback a `ast-grep` para TypeScript si ctags no está instalado.

**Para cada archivo `.ts`/`.tsx`:**
```bash
ctags -R --output-format=json --fields=+lnSztK --extras=+q {file}
```

Extrae: interfaces, types, enums, funciones exportadas, clases.
Filtra: funciones internas, variables locales, imports.

**Para archivos `.sql`/`.prisma`:**
Extrae el schema completo tal cual.

**Para `.env.example`:**
Extrae estructura de variables (sin valores).

---

## Git Hook — post-commit

Script en `.husky/post-commit` (se configura con `bun run setup`):

```bash
#!/bin/sh
# Solo actúa si existe .claude-bridge en el repo
if [ ! -f ".claude-bridge" ]; then exit 0; fi

# Obtiene archivos cambiados en el último commit
CHANGED=$(git diff-tree --no-commit-id -r --name-only HEAD)

# Filtra por extensiones relevantes
RELEVANT=$(echo "$CHANGED" | grep -E '\.(ts|tsx|sql|prisma|env\.example)$')

if [ -n "$RELEVANT" ]; then
  bun run --cwd $(cat .claude-bridge | grep mcp_server_path | cut -d: -f2) \
    scripts/snapshot.ts --files "$RELEVANT"
fi
```

---

## .claude-bridge (config por repo)

Archivo que vive en la raíz de cada proyecto cliente:

```yaml
project: PinTeach
mcp_server: http://localhost:3456
knowledge_path: ./knowledge
watcher:
  watch: ./src
  extensions: [.ts, .tsx, .sql, .prisma]
  section_mapping:
    src/db/**:        database
    src/api/**:       api
    src/auth/**:      auth
    src/components/**: frontend
    src/services/**:  services
```

---

## Proyecto identificado automáticamente

Claude Code lee `.claude-bridge` al arrancar en un directorio.
Las instrucciones en `CLAUDE.md` del proyecto claude-bridge dicen:

```markdown
Al iniciar en cualquier directorio, busca .claude-bridge en la raíz.
Si existe, llama a session_init con el project name de ese archivo.
Si no existe, llama a list_projects y pregunta al usuario cuál es su proyecto.
```

Claude.ai: las instrucciones del Project en Claude.ai (configuradas por ClaudeSync)
incluyen el mismo `.claude-bridge`, así que también sabe el project name sin que
el usuario tenga que decirlo.

---

## Auto-cleanup semanal

Script `scripts/cleanup.ts` ejecutado via cron o manualmente:

```typescript
// Criterios de limpieza:
// 1. Sección no leída (last_read_at) en más de 30 días → marca 'stale'
// 2. Sección 'stale' + no hay archivos de código mapeados → propone eliminar
// 3. Claude propone lista de cambios, usuario confirma antes de ejecutar
// 4. Nunca elimina secciones 'frozen' ni 'decisions.md'
```

---

## Seguridad (v1 — uso personal)

- Sin auth en v1 (uso local o behind tunnel)
- El MCP server escucha solo en localhost:3456 por defecto
- Para exponerlo a Claude.ai usar ngrok o cloudflare tunnel
- En v2: token simple en header `X-Bridge-Token`

---

## Instalación y setup

```bash
# 1. Clonar e instalar
git clone https://github.com/tu-usuario/claude-bridge
cd claude-bridge
bun install

# 2. Configurar en Claude Code (global)
claude mcp add --transport http claude-bridge http://localhost:3456

# 3. Configurar en Claude.ai
# Settings → Integrations → Add MCP Server
# URL: https://tu-tunnel.trycloudflare.com (o ngrok URL)

# 4. En cada repo que quieras conectar
cp .claude-bridge.example /ruta/a/tu-proyecto/.claude-bridge
# Edita project name y rutas

# 5. Setup git hooks en el repo cliente
cd /ruta/a/tu-proyecto
bun run --cwd /ruta/a/claude-bridge scripts/setup-hooks.ts
```
