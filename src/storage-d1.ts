// D1 storage adapter — async version of storage.ts for Cloudflare Workers
// Same function signatures but takes D1Database as first param and returns Promises

import type { Project, Section, SyncLogEntry, SyncAction, SyncSource } from './types.ts'
import { ok, err, type Result } from './types.ts'

// ---- Row types (D1 returns snake_case) ----

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

// ---- Projects ----

export async function getProject(db: D1Database, id: string): Promise<Result<Project>> {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?')
    .bind(id)
    .first<ProjectRow>()

  return row ? ok(toProject(row)) : err(`Project '${id}' not found`)
}

export async function upsertProject(
  db: D1Database,
  project: Omit<Project, 'createdAt'>
): Promise<Result<Project>> {
  const now = new Date().toISOString()
  await db.prepare(`
    INSERT INTO projects (id, path, created_at, last_sync)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      last_sync = excluded.last_sync
  `).bind(project.id, project.path, now, project.lastSync).run()

  return getProject(db, project.id)
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db.prepare('SELECT * FROM projects ORDER BY id')
    .all<ProjectRow>()
  return results.map(toProject)
}

export async function updateProjectSync(db: D1Database, id: string, lastSync: string): Promise<void> {
  await db.prepare('UPDATE projects SET last_sync = ? WHERE id = ?')
    .bind(lastSync, id).run()
}

// ---- Sections ----

export async function getSection(
  db: D1Database,
  projectId: string,
  sectionId: string
): Promise<Result<Section>> {
  const row = await db.prepare('SELECT * FROM sections WHERE project_id = ? AND id = ?')
    .bind(projectId, sectionId)
    .first<SectionRow>()

  return row ? ok(toSection(row)) : err(`Section '${sectionId}' not found`)
}

export async function listSections(db: D1Database, projectId: string): Promise<Section[]> {
  const { results } = await db.prepare('SELECT * FROM sections WHERE project_id = ? ORDER BY id')
    .bind(projectId)
    .all<SectionRow>()
  return results.map(toSection)
}

export async function upsertSection(
  db: D1Database,
  section: Omit<Section, 'lastReadAt'>
): Promise<Result<Section>> {
  await db.prepare(`
    INSERT INTO sections (id, project_id, status, summary, last_updated)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id, project_id) DO UPDATE SET
      status = excluded.status,
      summary = excluded.summary,
      last_updated = excluded.last_updated
  `).bind(
    section.id,
    section.projectId,
    section.status,
    section.summary ?? null,
    section.lastUpdated
  ).run()

  return getSection(db, section.projectId, section.id)
}

export async function updateSectionReadAt(
  db: D1Database,
  projectId: string,
  sectionId: string
): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare('UPDATE sections SET last_read_at = ? WHERE project_id = ? AND id = ?')
    .bind(now, projectId, sectionId).run()
}

export async function updateSectionStatus(
  db: D1Database,
  projectId: string,
  sectionId: string,
  status: string,
  summary?: string
): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(`
    UPDATE sections
    SET status = ?, summary = COALESCE(?, summary), last_updated = ?
    WHERE project_id = ? AND id = ?
  `).bind(status, summary ?? null, now, projectId, sectionId).run()
}

export async function deleteSection(
  db: D1Database,
  projectId: string,
  sectionId: string
): Promise<void> {
  await db.prepare('DELETE FROM sections WHERE project_id = ? AND id = ?')
    .bind(projectId, sectionId).run()
}

// ---- Sync log ----

export async function logSync(
  db: D1Database,
  projectId: string,
  sectionId: string,
  action: SyncAction,
  source: SyncSource
): Promise<void> {
  await db.prepare(`
    INSERT INTO sync_log (project_id, section_id, action, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(projectId, sectionId, action, source, new Date().toISOString()).run()
}
