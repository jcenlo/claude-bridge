// Shared types for the claude-bridge system

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

export interface Section {
  id: string
  projectId: string
  status: SectionStatus
  summary?: string
  lastUpdated: string  // ISO
  lastReadAt?: string  // ISO
}

export interface SyncLogEntry {
  id: number
  projectId: string
  sectionId: string
  action: SyncAction
  source: SyncSource
  createdAt: string    // ISO
}

// ---- Tool inputs ----

export interface SessionInitInput {
  project: string
  topic?: string
}

export interface GetContextInput {
  project: string
  section: string
}

export interface GetSnapshotInput {
  project: string
  section: string
}

export interface SaveContextInput {
  project: string
  section: string
  content: string
  lastReadAt?: string  // ISO — para optimistic locking
}

export interface SaveSnapshotInput {
  project: string
  section: string
  artifacts: {
    types?: string
    signatures?: string
    schema?: string
    env?: string
  }
}

export interface UpdateIndexInput {
  project: string
  section: string
  status: SectionStatus
  summary?: string
}

export interface SearchInput {
  project: string
  query: string
  scope?: 'narrative' | 'snapshots' | 'all'
}

export interface ListSectionsInput {
  project?: string
}

export interface DeleteContextInput {
  project: string
  section: string
  archive?: boolean
}

export interface KbResetInput {
  project: string
  sections?: string[]
}

// ---- Tool outputs ----

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

export interface SaveContextOutput {
  success: boolean
  conflict?: {
    yourVersion: string
    currentVersion: string
    lastUpdated: string
  }
}

export interface SearchResult {
  section: string
  fragment: string
  score: number
  type: 'narrative' | 'snapshot'
}

export interface HealthOutput {
  status: HealthStatus
  uptime: number
  lastSync: string
  watcherActive: boolean
  projects: number
  sectionsTotal: number
  sectionsOutdated: number
}

// ---- Config del repo cliente (.claude-bridge) ----

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

// ---- Result pattern (no throw) ----

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
