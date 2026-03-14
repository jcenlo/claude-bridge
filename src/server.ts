// MCP Server — define todos los tools del bridge
// Transport: Streamable HTTP (compatible con Claude.ai y Claude Code)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import {
  getProject, upsertProject, listProjects,
  getSection, listSections, upsertSection,
  updateSectionStatus, updateSectionReadAt,
  deleteSection, logSync,
} from './storage.ts'
import { extractFromFiles, buildSnapshotMd } from './extractor.ts'
import { getHealth, getSyncWarning } from './health.ts'
import type { SessionMode, SectionStatus } from './types.ts'

// Rewrites the sections table in INDEX.md from current DB state
function syncIndexMd(knowledgePath: string, projectId: string): void {
  const indexPath = join(knowledgePath, 'INDEX.md')
  if (!existsSync(indexPath)) return

  const content = readFileSync(indexPath, 'utf-8')
  const sections = listSections(projectId)

  // Build new sections table
  const tableHeader = '| id | file | status | last_updated | summary |'
  const tableSep = '|----|------|--------|--------------|---------|'
  const tableRows = sections.map(s =>
    `| ${s.id} | /knowledge/${s.id} | ${s.status} | ${s.lastUpdated.slice(0, 10)} | ${s.summary ?? ''} |`
  )

  // Replace the table between ## sections and ## active (or end of file)
  const newTable = [tableHeader, tableSep, ...tableRows].join('\n')
  const updated = content.replace(
    /\| id \|.*?\n\|[-| ]+\n(?:\|.*\n)*/m,
    newTable + '\n'
  )

  writeFileSync(indexPath, updated, 'utf-8')
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'claude-bridge',
    version: '0.1.0',
  })

  // ================================================================
  // session_init
  // Descripción crítica — hace que Claude lo llame automáticamente
  // ================================================================
  server.tool(
    'session_init',
    `ALWAYS call this tool at the very start of ANY development conversation,
before responding to the user. Pass the main topic as a string.
Returns project context so you never need to ask the user to re-explain the codebase.
If no project is specified, call list_projects first.`,
    {
      project: z.string().describe('Project name from .claude-bridge'),
      topic: z.string().optional().describe('Current work topic: "payments", "auth", etc.'),
    },
    async ({ project, topic }) => {
      const projectResult = getProject(project)

      // Modo bootstrap — proyecto sin KB
      if (!projectResult.ok) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: 'bootstrap' as SessionMode,
              project,
              syncStatus: 'unknown',
              lastSync: new Date().toISOString(),
              index: '',
              warnings: [
                `Project '${project}' has no knowledge base yet.`,
                `To get started, answer these questions:`,
                `1. What is the tech stack? (e.g. Next.js, Supabase, Bun)`,
                `2. What is the main goal of this project?`,
                `3. What sections do you want to track? (architecture, database, api, auth, frontend...)`,
                `Then call save_context to create each section.`,
              ],
            }, null, 2),
          }],
        }
      }

      const proj = projectResult.value
      const knowledgePath = proj.path
      const indexPath = join(knowledgePath, 'INDEX.md')

      if (!existsSync(indexPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: 'bootstrap' as SessionMode,
              project,
              syncStatus: 'unknown',
              lastSync: proj.lastSync,
              index: '',
              warnings: [`INDEX.md not found in ${knowledgePath}. Run bootstrap to generate it.`],
            }, null, 2),
          }],
        }
      }

      const index = readFileSync(indexPath, 'utf-8')
      const sections = listSections(project)
      const outdated = sections.filter(s => s.status === 'outdated')
      const syncWarning = getSyncWarning(proj.lastSync)
      const warnings: string[] = []

      if (syncWarning) warnings.push(syncWarning)
      if (outdated.length > 0) {
        warnings.push(`Outdated sections: ${outdated.map(s => s.id).join(', ')}`)
      }

      // Modo triage si hay secciones outdated
      const mode: SessionMode = outdated.length > 0 ? 'triage' : 'precision'

      // Carga sección relevante según topic
      let context: string | undefined
      let snapshot: string | undefined

      if (topic) {
        const relevantSection = sections.find(s =>
          s.id.includes(topic.toLowerCase()) ||
          topic.toLowerCase().includes(s.id)
        )

        if (relevantSection) {
          const narrativePath = join(knowledgePath, `${relevantSection.id}.md`)
          const snapshotPath = join(knowledgePath, `${relevantSection.id}.snap.md`)

          if (existsSync(narrativePath)) {
            context = readFileSync(narrativePath, 'utf-8')
            updateSectionReadAt(project, relevantSection.id)
          }
          if (existsSync(snapshotPath)) {
            snapshot = readFileSync(snapshotPath, 'utf-8')
          }
        }
      }

      const syncAge = Date.now() - new Date(proj.lastSync).getTime()
      const syncStatus = syncAge < 30 * 60 * 1000 ? 'fresh' : 'stale'

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            mode,
            project,
            syncStatus,
            lastSync: proj.lastSync,
            index,
            context,
            snapshot,
            warnings: warnings.length > 0 ? warnings : undefined,
          }, null, 2),
        }],
      }
    }
  )

  // ================================================================
  // get_context
  // ================================================================
  server.tool(
    'get_context',
    'Get the narrative context for a specific section. Returns the "why" — decisions, architecture, reasoning.',
    {
      project: z.string(),
      section: z.string(),
    },
    async ({ project, section }) => {
      const projectResult = getProject(project)
      if (!projectResult.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
      }

      const filePath = join(projectResult.value.path, `${section}.md`)
      if (!existsSync(filePath)) {
        return { content: [{ type: 'text' as const, text: `Section '${section}' not found.` }] }
      }

      updateSectionReadAt(project, section)
      const content = readFileSync(filePath, 'utf-8')
      return { content: [{ type: 'text' as const, text: content }] }
    }
  )

  // ================================================================
  // get_snapshot
  // ================================================================
  server.tool(
    'get_snapshot',
    'Get the auto-generated code snapshot for a section. Returns real types, interfaces, and function signatures.',
    {
      project: z.string(),
      section: z.string(),
    },
    async ({ project, section }) => {
      const projectResult = getProject(project)
      if (!projectResult.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
      }

      const filePath = join(projectResult.value.path, `${section}.snap.md`)
      if (!existsSync(filePath)) {
        return {
          content: [{
            type: 'text' as const,
            text: `No snapshot for '${section}' yet. Run the watcher or commit to generate one.`,
          }],
        }
      }

      const content = readFileSync(filePath, 'utf-8')
      return { content: [{ type: 'text' as const, text: content }] }
    }
  )

  // ================================================================
  // save_context
  // ================================================================
  server.tool(
    'save_context',
    'Save or update the narrative context for a section. Pass last_read_at to prevent overwriting concurrent changes.',
    {
      project: z.string(),
      section: z.string(),
      content: z.string(),
      lastReadAt: z.string().optional().describe('ISO timestamp of when you last read this section'),
    },
    async ({ project, section, content, lastReadAt }) => {
      let projectResult = getProject(project)

      // Auto-register project if it doesn't exist (bootstrap flow)
      if (!projectResult.ok) {
        const defaultPath = join(process.cwd(), 'knowledge')
        projectResult = upsertProject({
          id: project,
          path: defaultPath,
          lastSync: new Date().toISOString(),
        })
        if (!projectResult.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
        }
      }

      const knowledgePath = projectResult.value.path
      const filePath = join(knowledgePath, `${section}.md`)

      // Optimistic locking
      if (lastReadAt && existsSync(filePath)) {
        const sectionResult = getSection(project, section)
        if (sectionResult.ok && sectionResult.value.lastUpdated > lastReadAt) {
          const currentContent = readFileSync(filePath, 'utf-8')
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                conflict: {
                  yourVersion: content,
                  currentVersion: currentContent,
                  lastUpdated: sectionResult.value.lastUpdated,
                },
              }, null, 2),
            }],
          }
        }
      }

      if (!existsSync(knowledgePath)) mkdirSync(knowledgePath, { recursive: true })
      writeFileSync(filePath, content, 'utf-8')

      const now = new Date().toISOString()
      upsertSection({
        id: section,
        projectId: project,
        status: 'in-progress',
        lastUpdated: now,
      })
      logSync(project, section, 'write', 'claude_ai')

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    }
  )

  // ================================================================
  // save_snapshot (solo Claude Code)
  // ================================================================
  server.tool(
    'save_snapshot',
    'Save auto-generated code artifacts for a section. Only call from Claude Code after extracting types and signatures.',
    {
      project: z.string(),
      section: z.string(),
      artifacts: z.object({
        types: z.string().optional(),
        signatures: z.string().optional(),
        schema: z.string().optional(),
        env: z.string().optional(),
      }),
    },
    async ({ project, section, artifacts }) => {
      let projectResult = getProject(project)

      if (!projectResult.ok) {
        const defaultPath = join(process.cwd(), 'knowledge')
        projectResult = upsertProject({
          id: project,
          path: defaultPath,
          lastSync: new Date().toISOString(),
        })
        if (!projectResult.ok) {
          return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
        }
      }

      const knowledgePath = projectResult.value.path
      const now = new Date().toISOString()
      const snapshotContent = buildSnapshotMd(section, artifacts, now)
      const filePath = join(knowledgePath, `${section}.snap.md`)

      if (!existsSync(knowledgePath)) mkdirSync(knowledgePath, { recursive: true })
      writeFileSync(filePath, snapshotContent, 'utf-8')
      logSync(project, section, 'snapshot', 'claude_code')

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, updatedAt: now }) }],
      }
    }
  )

  // ================================================================
  // update_index
  // ================================================================
  server.tool(
    'update_index',
    'Update the status and summary of a section in INDEX.md.',
    {
      project: z.string(),
      section: z.string(),
      status: z.enum(['empty', 'in-progress', 'stable', 'outdated', 'frozen', 'stale']),
      summary: z.string().max(60).optional(),
    },
    async ({ project, section, status, summary }) => {
      updateSectionStatus(project, section, status as SectionStatus, summary)

      // Sync the INDEX.md file to match DB state
      const projectResult = getProject(project)
      if (projectResult.ok) {
        syncIndexMd(projectResult.value.path, project)
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      }
    }
  )

  // ================================================================
  // list_sections
  // ================================================================
  server.tool(
    'list_sections',
    'List all sections for a project with their current status.',
    {
      project: z.string().optional(),
    },
    async ({ project }) => {
      if (project) {
        const sections = listSections(project)
        return { content: [{ type: 'text' as const, text: JSON.stringify(sections, null, 2) }] }
      }

      const projects = listProjects()
      const all = projects.map(p => ({
        project: p.id,
        sections: listSections(p.id),
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }] }
    }
  )

  // ================================================================
  // list_projects
  // ================================================================
  server.tool(
    'list_projects',
    'List all registered projects. Call when no .claude-bridge is available to identify the project.',
    {},
    async () => {
      const projects = listProjects()
      return {
        content: [{
          type: 'text' as const,
          text: projects.length > 0
            ? JSON.stringify(projects.map(p => ({ id: p.id, lastSync: p.lastSync })), null, 2)
            : 'No projects registered yet. Use upsert_project to register one.',
        }],
      }
    }
  )

  // ================================================================
  // search
  // ================================================================
  server.tool(
    'search',
    'Search across the knowledge base for a project.',
    {
      project: z.string(),
      query: z.string(),
      scope: z.enum(['narrative', 'snapshots', 'all']).default('all'),
    },
    async ({ project, query, scope }) => {
      const projectResult = getProject(project)
      if (!projectResult.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
      }

      const knowledgePath = projectResult.value.path
      const sections = listSections(project)
      const results: Array<{ section: string; fragment: string; type: string }> = []
      const queryLower = query.toLowerCase()

      for (const section of sections) {
        if (section.status === 'frozen') continue

        const files: Array<{ path: string; type: 'narrative' | 'snapshot' }> = []
        if (scope !== 'snapshots') files.push({ path: join(knowledgePath, `${section.id}.md`), type: 'narrative' })
        if (scope !== 'narrative') files.push({ path: join(knowledgePath, `${section.id}.snap.md`), type: 'snapshot' })

        for (const { path, type } of files) {
          if (!existsSync(path)) continue
          const content = readFileSync(path, 'utf-8')
          if (!content.toLowerCase().includes(queryLower)) continue

          // Extrae fragmento alrededor del match
          const idx = content.toLowerCase().indexOf(queryLower)
          const start = Math.max(0, idx - 100)
          const end = Math.min(content.length, idx + 200)
          const fragment = content.slice(start, end).trim()

          results.push({ section: section.id, fragment, type })
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: results.length > 0
            ? JSON.stringify(results, null, 2)
            : `No results for "${query}" in project ${project}`,
        }],
      }
    }
  )

  // ================================================================
  // delete_context
  // ================================================================
  server.tool(
    'delete_context',
    'Delete a section from the knowledge base. Archives by default.',
    {
      project: z.string(),
      section: z.string(),
      archive: z.boolean().default(true),
    },
    async ({ project, section, archive }) => {
      const projectResult = getProject(project)
      if (!projectResult.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
      }

      const knowledgePath = projectResult.value.path
      const filePath = join(knowledgePath, `${section}.md`)
      const snapPath = join(knowledgePath, `${section}.snap.md`)

      if (archive && existsSync(filePath)) {
        renameSync(filePath, join(knowledgePath, `${section}-archived.md`))
      }
      if (archive && existsSync(snapPath)) {
        renameSync(snapPath, join(knowledgePath, `${section}-archived.snap.md`))
      }

      // Remove non-archived files
      if (!archive) {
        if (existsSync(filePath)) unlinkSync(filePath)
        if (existsSync(snapPath)) unlinkSync(snapPath)
      }

      deleteSection(project, section)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, archived: archive }) }],
      }
    }
  )

  // ================================================================
  // kb_reset
  // ================================================================
  server.tool(
    'kb_reset',
    'Reset sections after a major refactor. Preserves history as versioned files.',
    {
      project: z.string(),
      sections: z.array(z.string()).optional().describe('Sections to reset. If empty, resets all.'),
    },
    async ({ project, sections }) => {
      const projectResult = getProject(project)
      if (!projectResult.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${projectResult.error}` }] }
      }

      const knowledgePath = projectResult.value.path
      const allSections = listSections(project)
      const toReset = sections?.length
        ? allSections.filter(s => sections.includes(s.id))
        : allSections.filter(s => s.status !== 'frozen')

      const reset: string[] = []

      for (const section of toReset) {
        const filePath = join(knowledgePath, `${section.id}.md`)
        if (existsSync(filePath)) {
          // Versiona el archivo existente
          let version = 1
          while (existsSync(join(knowledgePath, `${section.id}-v${version}.md`))) version++
          renameSync(filePath, join(knowledgePath, `${section.id}-v${version}.md`))
        }
        updateSectionStatus(project, section.id, 'empty')
        logSync(project, section.id, 'reset', 'claude_code')
        reset.push(section.id)
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            reset,
            message: `${reset.length} sections reset. Previous versions preserved as *-v1.md files.`,
          }, null, 2),
        }],
      }
    }
  )

  // ================================================================
  // get_health
  // ================================================================
  server.tool(
    'get_health',
    'Get the health status of the bridge server and watcher.',
    {},
    async () => {
      const health = getHealth()
      return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] }
    }
  )

  return server
}
