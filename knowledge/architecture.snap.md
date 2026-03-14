# snapshot: architecture
> auto-generated — do not edit manually
> updated: 2026-03-14T12:47:15.616Z

## types & interfaces
```typescript
// src/extractor.ts:15
export interface ExtractedArtifacts {
  types?: string
  signatures?: string
  schema?: string
  env?: string
}

// src/types.ts:3
export type SectionStatus =
  | 'empty'
  | 'in-progress'
  | 'stable'
  | 'outdated'
  | 'frozen'
  | 'stale'

export type SessionMode = 'bootstrap' | 'triage' | 'precision'

export type SyncSource = 'claude_ai' | 'claude_code' | 'watcher' | 'hook'

export type SyncAction = 'write' | 'snapshot' | 'reset' | 'cleanup'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:11
export type SessionMode = 'bootstrap' | 'triage' | 'precision'

export type SyncSource = 'claude_ai' | 'claude_code' | 'watcher' | 'hook'

export type SyncAction = 'write' | 'snapshot' | 'reset' | 'cleanup'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:13
export type SyncSource = 'claude_ai' | 'claude_code' | 'watcher' | 'hook'

export type SyncAction = 'write' | 'snapshot' | 'reset' | 'cleanup'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:15
export type SyncAction = 'write' | 'snapshot' | 'reset' | 'cleanup'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:17
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:19
export interface Project {
  id: string
  path: string         // path absoluto al /knowledge del repo
  createdAt: string    // ISO
  lastSync: string     // ISO — heartbeat del watcher
}

// src/types.ts:26
export interface Section {
  id: string
  projectId: string
  status: SectionStatus
  summary?: string
  lastUpdated: string  // ISO
  lastReadAt?: string  // ISO
}

// src/types.ts:35
export interface SyncLogEntry {
  id: number
  projectId: string
  sectionId: string
  action: SyncAction
  source: SyncSource
  createdAt: string    // ISO
}

// src/types.ts:46
export interface SessionInitOutput {
  mode: SessionMode
  project: string
  syncStatus: 'fresh' | 'stale' | 'unknown'
  lastSync: string
  index: string
  context?: string
  snapshot?: string
  warnings?: string[]
}

// src/types.ts:57
export interface SaveContextOutput {
  success: boolean
  conflict?: {
    yourVersion: string
    currentVersion: string
    lastUpdated: string
  }
}

// src/types.ts:66
export interface HealthOutput {
  status: HealthStatus
  uptime: number
  lastSync: string
  watcherActive: boolean
  projects: number
  sectionsTotal: number
  sectionsOutdated: number
}

// src/types.ts:78
export interface ClaudeBridgeConfig {
  project: string
  mcpServer: string
  knowledgePath: string
  watcher: {
    watch: string
    extensions: string[]
    sectionMapping: Record<string, string>  // glob → section id
  }
}

// src/types.ts:91
export type Result<T, E = string> =
  | { ok: true; value: T }
```

## exported functions
```typescript
// src/auth.ts:76
export function handleProtectedResourceMetadata(req: Request): Response
// src/auth.ts:88
export function handleAuthServerMetadata(req: Request): Response
// src/auth.ts:104
export async function handleRegister(req: Request): Promise<Response>
// src/auth.ts:145
export function handleAuthorize(req: Request): Response
// src/auth.ts:195
export async function handleToken(req: Request): Promise<Response>
// src/auth.ts:287
export function validateBearerToken(req: Request): boolean
// src/auth.ts:303
export function unauthorized(req: Request): Response
// src/extractor.ts:50
export async function extractFromFiles( files: string[] ): Promise<Result<ExtractedArtifacts>>
// src/extractor.ts:261
export function buildSnapshotMd( section: string, artifacts: ExtractedArtifacts, updatedAt: string ): string
// src/server.ts:43
export function createServer(): McpServer
// src/storage-d1.ts:47
export async function getProject(db: D1Database, id: string): Promise<Result<Project>>
// src/storage-d1.ts:55
export async function upsertProject( db: D1Database, project: Omit<Project, 'createdAt'> ): Promise<Result<Project>>
// src/storage-d1.ts:71
export async function listProjects(db: D1Database): Promise<Project[]>
// src/storage-d1.ts:77
export async function updateProjectSync(db: D1Database, id: string, lastSync: string): Promise<void>
// src/storage-d1.ts:84
export async function getSection( db: D1Database, projectId: string, sectionId: string ): Promise<Result<Section>>
// src/storage-d1.ts:96
export async function listSections(db: D1Database, projectId: string): Promise<Section[]>
// src/storage-d1.ts:103
export async function upsertSection( db: D1Database, section: Omit<Section, 'lastReadAt'> ): Promise<Result<Section>>
// src/storage-d1.ts:125
export async function updateSectionReadAt( db: D1Database, projectId: string, sectionId: string ): Promise<void>
// src/storage-d1.ts:135
export async function updateSectionStatus( db: D1Database, projectId: string, sectionId: string, status: string,
// src/storage-d1.ts:150
export async function deleteSection( db: D1Database, projectId: string, sectionId: string ): Promise<void>
// src/storage-d1.ts:161
export async function logSync( db: D1Database, projectId: string, sectionId: string, action: SyncAction,
// src/types.ts:95
export function ok<T>(value: T): Result<T, never>
// src/types.ts:99
export function err<E>(error: E): Result<never, E>
// src/watcher.ts:53
export function startWatcher(repoPath: string, projectId: string): void
```

## schema
```sql
-- migrations/0001_initial.sql
-- claude-bridge D1 schema
-- Mirrors the local bun:sqlite schema + auth tables for OAuth persistence

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_sync   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'empty',
  summary      TEXT,
  last_updated TEXT NOT NULL,
  last_read_at TEXT,
  PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id, created_at DESC);

-- OAuth tables for Claude.ai auth persistence across Worker isolates

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_secret TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  client_name   TEXT,
  grant_types   TEXT NOT NULL DEFAULT 'authorization_code',
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope                 TEXT NOT NULL DEFAULT 'mcp:tools',
  state                 TEXT,
  expires_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'mcp:tools',
  expires_at INTEGER NOT NULL
);

```
