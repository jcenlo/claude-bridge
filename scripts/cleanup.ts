#!/usr/bin/env bun
// Auto-cleanup semanal — marca secciones stale y propone eliminación
// Uso: bun scripts/cleanup.ts --project claude-bridge [--dry-run]

import { join } from 'path'
import { existsSync, readdirSync, readFileSync, renameSync } from 'fs'
import { getProject, listSections, updateSectionStatus, deleteSection } from '../src/storage.ts'
import type { Section } from '../src/types.ts'

const args = process.argv.slice(2)
const projectIdx = args.indexOf('--project')
const projectId = projectIdx >= 0 ? args[projectIdx + 1] : undefined
const dryRun = args.includes('--dry-run')

if (!projectId) {
  console.error('Usage: bun scripts/cleanup.ts --project <name> [--dry-run]')
  process.exit(1)
}

const projectResult = getProject(projectId)
if (!projectResult.ok) {
  console.error(`Error: ${projectResult.error}`)
  process.exit(1)
}

const knowledgePath = projectResult.value.path
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const now = Date.now()

// Load section mapping from .claude-bridge to check if code files exist
function loadSectionMapping(repoRoot: string): Record<string, string> {
  const configPath = join(repoRoot, '.claude-bridge')
  if (!existsSync(configPath)) return {}
  const content = readFileSync(configPath, 'utf-8')
  const mapping: Record<string, string> = {}
  let inMapping = false
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('section_mapping')) { inMapping = true; continue }
    if (inMapping) {
      if (!line.startsWith('    ')) { inMapping = false; continue }
      const colonIdx = line.trim().indexOf(':')
      if (colonIdx < 0) continue
      const prefix = line.trim().slice(0, colonIdx).trim()
      const section = line.trim().slice(colonIdx + 1).trim()
      mapping[prefix] = section
    }
  }
  return mapping
}

// Check if any code files map to this section
function hasMappedFiles(sectionId: string, repoRoot: string, mapping: Record<string, string>): boolean {
  // Find prefixes that map to this section
  const prefixes = Object.entries(mapping)
    .filter(([, s]) => s === sectionId)
    .map(([p]) => p)

  if (prefixes.length === 0) return false

  for (const prefix of prefixes) {
    const dir = join(repoRoot, prefix)
    if (existsSync(dir)) {
      try {
        const files = readdirSync(dir, { recursive: true }) as string[]
        if (files.length > 0) return true
      } catch { /* dir might not be readable */ }
    }
  }
  return false
}

// ---- Main ----

const sections = listSections(projectId)
const repoRoot = process.cwd()
const mapping = loadSectionMapping(repoRoot)

interface CleanupAction {
  section: string
  action: 'mark_stale' | 'propose_delete'
  reason: string
}

const actions: CleanupAction[] = []

console.log(`\n🧹 Cleanup scan for project: ${projectId}`)
console.log(`   Knowledge: ${knowledgePath}`)
console.log(`   Sections: ${sections.length}`)
if (dryRun) console.log('   Mode: DRY RUN\n')
else console.log('')

for (const section of sections) {
  // Never touch frozen sections or decisions
  if (section.status === 'frozen') {
    console.log(`   ⏸  ${section.id} — frozen, skipped`)
    continue
  }
  if (section.id === 'decisions') {
    console.log(`   📋 ${section.id} — protected, skipped`)
    continue
  }

  // Check if last_read_at is older than 30 days
  const lastRead = section.lastReadAt ? new Date(section.lastReadAt).getTime() : 0
  const daysSinceRead = lastRead > 0 ? Math.floor((now - lastRead) / (24 * 60 * 60 * 1000)) : Infinity

  if (daysSinceRead > 30 && section.status !== 'stale') {
    const reason = lastRead > 0
      ? `not read in ${daysSinceRead} days`
      : 'never read'
    actions.push({ section: section.id, action: 'mark_stale', reason })
  }

  // If already stale, check if code files exist
  if (section.status === 'stale' || (daysSinceRead > 30 && section.status !== 'stale')) {
    const hasFiles = hasMappedFiles(section.id, repoRoot, mapping)
    if (!hasFiles) {
      actions.push({
        section: section.id,
        action: 'propose_delete',
        reason: 'stale + no mapped code files',
      })
    }
  }
}

// ---- Report ----

if (actions.length === 0) {
  console.log('✅ Nothing to clean up — all sections are healthy.\n')
  process.exit(0)
}

console.log('Proposed actions:\n')

const staleActions = actions.filter(a => a.action === 'mark_stale')
const deleteActions = actions.filter(a => a.action === 'propose_delete')

for (const a of staleActions) {
  console.log(`   ⚠️  ${a.section} → mark as stale (${a.reason})`)
}
for (const a of deleteActions) {
  console.log(`   🗑  ${a.section} → propose deletion (${a.reason})`)
}

console.log(`\n   Total: ${staleActions.length} to mark stale, ${deleteActions.length} to propose deletion`)

if (dryRun) {
  console.log('\n   --dry-run: no changes made.\n')
  process.exit(0)
}

// ---- Execute with confirmation ----

process.stdout.write('\nProceed? [y/N] ')

const response = await new Promise<string>((resolve) => {
  process.stdin.once('data', (data) => resolve(data.toString().trim().toLowerCase()))
})

if (response !== 'y' && response !== 'yes') {
  console.log('Aborted.\n')
  process.exit(0)
}

let applied = 0

for (const a of staleActions) {
  updateSectionStatus(projectId, a.section, 'stale')
  console.log(`   ✓ ${a.section} → stale`)
  applied++
}

for (const a of deleteActions) {
  // Archive, don't hard-delete — rename .md to -archived.md
  const mdPath = join(knowledgePath, `${a.section}.md`)
  const snapPath = join(knowledgePath, `${a.section}.snap.md`)

  if (existsSync(mdPath)) {
    renameSync(mdPath, join(knowledgePath, `${a.section}-archived.md`))
  }
  if (existsSync(snapPath)) {
    renameSync(snapPath, join(knowledgePath, `${a.section}-archived.snap.md`))
  }

  deleteSection(projectId, a.section)
  console.log(`   ✓ ${a.section} → archived and removed from index`)
  applied++
}

console.log(`\n✅ Done — ${applied} actions applied.\n`)
