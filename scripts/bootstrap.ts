#!/usr/bin/env bun
// Genera el knowledge base inicial para un proyecto existente
// Uso: bun scripts/bootstrap.ts --repo /path/to/project --project pinteach

import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { upsertProject, upsertSection } from '../src/storage.ts'
import { extractFromFiles, buildSnapshotMd } from '../src/extractor.ts'

const args = process.argv.slice(2)
const repoArg = args[args.indexOf('--repo') + 1]
const projectArg = args[args.indexOf('--project') + 1]

if (!repoArg || !projectArg) {
  console.error('Usage: bun scripts/bootstrap.ts --repo /path/to/project --project project-id')
  process.exit(1)
}

const repoPath = repoArg
const projectId = projectArg
const knowledgePath = join(repoPath, 'knowledge')

console.log(`\n🚀 Bootstrapping knowledge base for: ${projectId}`)
console.log(`   Repo: ${repoPath}`)
console.log(`   Knowledge path: ${knowledgePath}\n`)

mkdirSync(knowledgePath, { recursive: true })

// Registra el proyecto
upsertProject({
  id: projectId,
  path: knowledgePath,
  lastSync: new Date().toISOString(),
})

// Busca archivos relevantes por tipo
const sectionMapping: Record<string, string[]> = {
  database: [],
  api: [],
  auth: [],
  frontend: [],
  services: [],
}

function scanDir(dir: string): void {
  if (!existsSync(dir)) return
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', '.next', 'build'].includes(entry)) continue
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        scanDir(fullPath)
      } else {
        const relPath = fullPath.replace(repoPath + '/', '')
        const ext = entry.split('.').pop() ?? ''

        if (!['ts', 'tsx', 'sql', 'prisma'].includes(ext)) continue

        if (relPath.includes('/db/') || relPath.includes('/database/') || entry.includes('schema') || entry.includes('migration')) {
          sectionMapping.database?.push(fullPath)
        } else if (relPath.includes('/api/') || relPath.includes('/routes/') || relPath.includes('/endpoints/')) {
          sectionMapping.api?.push(fullPath)
        } else if (relPath.includes('/auth/') || relPath.includes('/middleware/')) {
          sectionMapping.auth?.push(fullPath)
        } else if (relPath.includes('/components/') || relPath.includes('/pages/') || relPath.includes('/app/')) {
          sectionMapping.frontend?.push(fullPath)
        } else if (relPath.includes('/services/') || relPath.includes('/lib/')) {
          sectionMapping.services?.push(fullPath)
        }
      }
    }
  } catch { /* skip permission errors */ }
}

scanDir(join(repoPath, 'src'))
scanDir(join(repoPath, 'app'))
scanDir(join(repoPath, 'lib'))

// Genera snapshots para las secciones que tienen archivos
const sections: Array<{ id: string; fileCount: number }> = []
const now = new Date().toISOString()

for (const [section, files] of Object.entries(sectionMapping)) {
  if (files.length === 0) continue

  console.log(`📦 Extracting ${section} (${files.length} files)...`)

  const result = await extractFromFiles(files)
  if (result.ok && Object.values(result.value).some(Boolean)) {
    const snapshotContent = buildSnapshotMd(section, result.value, now)
    writeFileSync(join(knowledgePath, `${section}.snap.md`), snapshotContent)

    // Crea un .md narrativo vacío como placeholder
    const narrativePath = join(knowledgePath, `${section}.md`)
    if (!existsSync(narrativePath)) {
      writeFileSync(narrativePath, `# ${section}\n\n> TODO: add narrative context\n`)
    }

    upsertSection({
      id: section,
      projectId,
      status: 'in-progress',
      summary: `${files.length} files detected`,
      lastUpdated: now,
    })

    sections.push({ id: section, fileCount: files.length })
  }
}

// Genera INDEX.md
const indexContent = [
  `# PROJECT: ${projectId}`,
  `> stack: (fill this in)`,
  `> status: active`,
  `> last_sync: ${now}`,
  '',
  '## sections',
  '',
  '| id | file | status | last_updated | summary |',
  '|----|------|--------|--------------|---------|',
  ...sections.map(s =>
    `| ${s.id} | /knowledge/${s.id} | in-progress | ${now.slice(0, 10)} | ${s.fileCount} files detected |`
  ),
  '',
  '## active',
  'working-on: (fill this in)',
].join('\n')

writeFileSync(join(knowledgePath, 'INDEX.md'), indexContent)

// Crea el .claude-bridge config
const bridgeConfig = `project: ${projectId}
mcp_server: http://localhost:3456
knowledge_path: ./knowledge
watcher:
  watch: ./src
  extensions: [.ts, .tsx, .sql, .prisma]
  section_mapping:
    src/db: database
    src/database: database
    src/api: api
    src/routes: api
    src/auth: auth
    src/middleware: auth
    src/components: frontend
    src/app: frontend
    src/services: services
    src/lib: services
`

const bridgePath = join(repoPath, '.claude-bridge')
if (!existsSync(bridgePath)) {
  writeFileSync(bridgePath, bridgeConfig)
  console.log(`\n✅ Created .claude-bridge`)
}

console.log(`\n✅ Bootstrap complete!`)
console.log(`   Sections created: ${sections.map(s => s.id).join(', ')}`)
console.log(`   Next steps:`)
console.log(`   1. Edit /knowledge/INDEX.md — fill in stack and working-on`)
console.log(`   2. Edit each /knowledge/{section}.md — add narrative context`)
console.log(`   3. Run: bun run dev (to start the MCP server)`)
console.log(`   4. Configure Claude Code: claude mcp add --transport http claude-bridge http://localhost:3456`)
