// Capa de acceso a SQLite
// Solo guarda metadata — el contenido real vive en archivos .md en el repo

import Database from 'better-sqlite3'
import { join } from 'path'
import type { Project, Section, SyncLogEntry, SyncAction, SyncSource } from './types.ts'
import { ok, err, type Result } from './types.ts'

const DB_PATH = process.env.BRIDGE_DB_PATH ?? join(import.meta.dir, '../data/bridge.db')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
  }
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
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
  `)
}

// ---- Projects ----

export function getProject(id: string): Result<Project> {
  const row = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as Project | undefined

  return row ? ok(row) : err(`Project '${id}' not found`)
}

export function upsertProject(project: Omit<Project, 'createdAt'>): Result<Project> {
  const now = new Date().toISOString()
  getDb()
    .prepare(`
      INSERT INTO projects (id, path, created_at, last_sync)
      VALUES (@id, @path, @createdAt, @lastSync)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        last_sync = excluded.last_sync
    `)
    .run({ ...project, createdAt: now })

  return getProject(project.id)
}

export function listProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY id').all() as Project[]
}

export function updateProjectSync(id: string, lastSync: string): void {
  getDb()
    .prepare('UPDATE projects SET last_sync = ? WHERE id = ?')
    .run(lastSync, id)
}

// ---- Sections ----

export function getSection(projectId: string, sectionId: string): Result<Section> {
  const row = getDb()
    .prepare('SELECT * FROM sections WHERE project_id = ? AND id = ?')
    .get(projectId, sectionId) as Section | undefined

  return row ? ok(row) : err(`Section '${sectionId}' not found in project '${projectId}'`)
}

export function listSections(projectId: string): Section[] {
  return getDb()
    .prepare('SELECT * FROM sections WHERE project_id = ? ORDER BY id')
    .all(projectId) as Section[]
}

export function upsertSection(
  section: Omit<Section, 'lastReadAt'>
): Result<Section> {
  getDb()
    .prepare(`
      INSERT INTO sections (id, project_id, status, summary, last_updated)
      VALUES (@id, @projectId, @status, @summary, @lastUpdated)
      ON CONFLICT(id, project_id) DO UPDATE SET
        status = excluded.status,
        summary = excluded.summary,
        last_updated = excluded.last_updated
    `)
    .run(section)

  return getSection(section.projectId, section.id)
}

export function updateSectionReadAt(projectId: string, sectionId: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE sections SET last_read_at = ? WHERE project_id = ? AND id = ?')
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
    .prepare(`
      UPDATE sections
      SET status = ?, summary = COALESCE(?, summary), last_updated = ?
      WHERE project_id = ? AND id = ?
    `)
    .run(status, summary ?? null, now, projectId, sectionId)
}

export function deleteSection(projectId: string, sectionId: string): void {
  getDb()
    .prepare('DELETE FROM sections WHERE project_id = ? AND id = ?')
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
    .prepare(`
      INSERT INTO sync_log (project_id, section_id, action, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(projectId, sectionId, action, source, new Date().toISOString())
}

export function getRecentSyncs(projectId: string, limit = 20): SyncLogEntry[] {
  return getDb()
    .prepare(`
      SELECT * FROM sync_log
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(projectId, limit) as SyncLogEntry[]
}
