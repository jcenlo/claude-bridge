// Capa de acceso a SQLite (bun:sqlite nativo)
// Solo guarda metadata — el contenido real vive en archivos .md en el repo

import { Database } from 'bun:sqlite'
import { join } from 'path'
import type { Project, Section, SyncLogEntry, SyncAction, SyncSource } from './types.ts'
import { ok, err, type Result } from './types.ts'

const DB_PATH = process.env.BRIDGE_DB_PATH ?? join(import.meta.dir, '../data/bridge.db')

let db: Database

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  }
  return db
}

function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_sync   TEXT NOT NULL
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS sections (
    id           TEXT NOT NULL,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'empty',
    summary      TEXT,
    last_updated TEXT NOT NULL,
    last_read_at TEXT,
    PRIMARY KEY (id, project_id)
  )`)

  db.exec(`CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)

  db.exec('CREATE INDEX IF NOT EXISTS idx_sections_project ON sections(project_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id, created_at DESC)')
}

// ---- Row → Type mappers (snake_case → camelCase) ----

interface ProjectRow {
  id: string
  path: string
  created_at: string
  last_sync: string
}

interface SectionRow {
  id: string
  project_id: string
  status: string
  summary: string | null
  last_updated: string
  last_read_at: string | null
}

interface SyncLogRow {
  id: number
  project_id: string
  section_id: string
  action: string
  source: string
  created_at: string
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.path,
    createdAt: row.created_at,
    lastSync: row.last_sync,
  }
}

function toSection(row: SectionRow): Section {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as Section['status'],
    summary: row.summary ?? undefined,
    lastUpdated: row.last_updated,
    lastReadAt: row.last_read_at ?? undefined,
  }
}

function toSyncLogEntry(row: SyncLogRow): SyncLogEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    sectionId: row.section_id,
    action: row.action as SyncAction,
    source: row.source as SyncSource,
    createdAt: row.created_at,
  }
}

// ---- Projects ----

export function getProject(id: string): Result<Project> {
  const row = getDb()
    .query('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | null

  return row ? ok(toProject(row)) : err(`Project '${id}' not found`)
}

export function upsertProject(project: Omit<Project, 'createdAt'>): Result<Project> {
  const now = new Date().toISOString()
  getDb()
    .query(`
      INSERT INTO projects (id, path, created_at, last_sync)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        last_sync = excluded.last_sync
    `)
    .run(project.id, project.path, now, project.lastSync)

  return getProject(project.id)
}

export function listProjects(): Project[] {
  const rows = getDb()
    .query('SELECT * FROM projects ORDER BY id')
    .all() as ProjectRow[]
  return rows.map(toProject)
}

export function updateProjectSync(id: string, lastSync: string): void {
  getDb()
    .query('UPDATE projects SET last_sync = ? WHERE id = ?')
    .run(lastSync, id)
}

// ---- Sections ----

export function getSection(projectId: string, sectionId: string): Result<Section> {
  const row = getDb()
    .query('SELECT * FROM sections WHERE project_id = ? AND id = ?')
    .get(projectId, sectionId) as SectionRow | null

  return row ? ok(toSection(row)) : err(`Section '${sectionId}' not found in project '${projectId}'`)
}

export function listSections(projectId: string): Section[] {
  const rows = getDb()
    .query('SELECT * FROM sections WHERE project_id = ? ORDER BY id')
    .all(projectId) as SectionRow[]
  return rows.map(toSection)
}

export function upsertSection(
  section: Omit<Section, 'lastReadAt'>
): Result<Section> {
  getDb()
    .query(`
      INSERT INTO sections (id, project_id, status, summary, last_updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id, project_id) DO UPDATE SET
        status = excluded.status,
        summary = excluded.summary,
        last_updated = excluded.last_updated
    `)
    .run(
      section.id,
      section.projectId,
      section.status,
      section.summary ?? null,
      section.lastUpdated
    )

  return getSection(section.projectId, section.id)
}

export function updateSectionReadAt(projectId: string, sectionId: string): void {
  const now = new Date().toISOString()
  getDb()
    .query('UPDATE sections SET last_read_at = ? WHERE project_id = ? AND id = ?')
    .run(now, projectId, sectionId)
}

export function updateSectionStatus(
  projectId: string,
  sectionId: string,
  status: Section['status'],
  summary?: string
): void {
  const now = new Date().toISOString()
  getDb()
    .query(`
      UPDATE sections
      SET status = ?, summary = COALESCE(?, summary), last_updated = ?
      WHERE project_id = ? AND id = ?
    `)
    .run(status, summary ?? null, now, projectId, sectionId)
}

export function deleteSection(projectId: string, sectionId: string): void {
  getDb()
    .query('DELETE FROM sections WHERE project_id = ? AND id = ?')
    .run(projectId, sectionId)
}

// ---- Sync log ----

export function logSync(
  projectId: string,
  sectionId: string,
  action: SyncAction,
  source: SyncSource
): void {
  getDb()
    .query(`
      INSERT INTO sync_log (project_id, section_id, action, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(projectId, sectionId, action, source, new Date().toISOString())
}

export function getRecentSyncs(projectId: string, limit = 20): SyncLogEntry[] {
  const rows = getDb()
    .query(`
      SELECT * FROM sync_log
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(projectId, limit) as SyncLogRow[]
  return rows.map(toSyncLogEntry)
}
