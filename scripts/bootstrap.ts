#!/usr/bin/env bun
// Genera el knowledge base inicial para un proyecto existente
// Uso: bun scripts/bootstrap.ts --repo /path/to/project --project pinteach

import { join, resolve } from 'path'
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs'
import { upsertProject, upsertSection } from '../src/storage.ts'
import { extractFromFiles, buildSnapshotMd } from '../src/extractor.ts'

const args = process.argv.slice(2)
const repoIdx = args.indexOf('--repo')
const projectIdx = args.indexOf('--project')
const repoArg = repoIdx >= 0 ? args[repoIdx + 1] : undefined
const projectArg = projectIdx >= 0 ? args[projectIdx + 1] : undefined

if (!repoArg || !projectArg) {
  console.error('Usage: bun scripts/bootstrap.ts --repo /path/to/project --project project-id')
  process.exit(1)
}

const repoPath = resolve(repoArg)
const projectId = projectArg
const knowledgePath = join(repoPath, 'knowledge')

console.log(`\n🚀 Bootstrapping knowledge base for: ${projectId}`)
console.log(`   Repo: ${repoPath}`)
console.log(`   Knowledge path: ${knowledgePath}\n`)

mkdirSync(knowledgePath, { recursive: true })

// Registra el proyecto en la DB
upsertProject({
  id: projectId,
  path: knowledgePath,
  lastSync: new Date().toISOString(),
})

// Patrones de categorización: path fragment → section
const categoryPatterns: Array<{ patterns: string[]; section: string }> = [
  { patterns: ['/db/', '/database/', 'schema', 'migration', 'seed'], section: 'database' },
  { patterns: ['/api/', '/routes/', '/endpoints/', '/handlers/'], section: 'api' },
  { patterns: ['/auth/', '/middleware/'], section: 'auth' },
  { patterns: ['/components/', '/pages/', '/app/', '/views/', '/layouts/'], section: 'frontend' },
  { patterns: ['/services/', '/lib/', '/utils/', '/helpers/'], section: 'services' },
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage', 'knowledge'])
const SOURCE_EXTS = new Set(['ts', 'tsx', 'sql', 'prisma'])

// Clasifica un archivo en una sección
function classifyFile(relPath: string, fileName: string): string {
  const lower = relPath.toLowerCase()
  for (const { patterns, section } of categoryPatterns) {
    if (patterns.some(p => lower.includes(p))) return section
  }
  // Catch-all: archivos que no matchean van a "architecture"
  return 'architecture'
}

// Busca archivos relevantes recursivamente
function scanDir(dir: string): string[] {
  const found: string[] = []
  if (!existsSync(dir)) return found

  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        found.push(...scanDir(fullPath))
      } else {
        const ext = entry.split('.').pop() ?? ''
        if (SOURCE_EXTS.has(ext)) found.push(fullPath)
      }
    }
  } catch { /* skip permission errors */ }
  return found
}

// Escanea directorios estándar de código fuente
const scanDirs = ['src', 'app', 'apps', 'lib', 'packages', 'scripts'].map(d => join(repoPath, d))
const allFiles = scanDirs.flatMap(scanDir)

// Agrupa archivos por sección
const sectionFiles: Record<string, string[]> = {}
for (const file of allFiles) {
  const relPath = file.replace(repoPath + '/', '')
  const fileName = file.split('/').pop() ?? ''
  const section = classifyFile(relPath, fileName)

  if (!sectionFiles[section]) sectionFiles[section] = []
  sectionFiles[section]!.push(file)
}

console.log(`📂 Found ${allFiles.length} source files across ${Object.keys(sectionFiles).length} sections\n`)

// Genera snapshots para cada sección
const sections: Array<{ id: string; fileCount: number; hasContent: boolean }> = []
const now = new Date().toISOString()

for (const [section, files] of Object.entries(sectionFiles)) {
  if (!files || files.length === 0) continue

  console.log(`📦 ${section} (${files.length} files)`)
  for (const f of files) {
    console.log(`   ${f.replace(repoPath + '/', '')}`)
  }

  const result = await extractFromFiles(files)
  const hasContent = result.ok && Object.values(result.value).some(Boolean)

  if (hasContent) {
    const snapshotContent = buildSnapshotMd(section, result.value, now)
    writeFileSync(join(knowledgePath, `${section}.snap.md`), snapshotContent)
  }

  // Crea un .md narrativo vacío como placeholder
  const narrativePath = join(knowledgePath, `${section}.md`)
  if (!existsSync(narrativePath)) {
    writeFileSync(narrativePath, `# ${section}\n\n> TODO: add narrative context\n`)
  }

  upsertSection({
    id: section,
    projectId,
    status: hasContent ? 'in-progress' : 'empty',
    summary: `${files.length} files`,
    lastUpdated: now,
  })

  sections.push({ id: section, fileCount: files.length, hasContent })
}

// Genera INDEX.md
const indexLines = [
  `# PROJECT: ${projectId}`,
  `> stack: (fill this in)`,
  `> status: active`,
  `> last_sync: ${now}`,
  '',
  '## sections',
  '',
  '| id | file | status | last_updated | summary |',
  '|----|------|--------|--------------|---------|',
]

for (const s of sections) {
  const status = s.hasContent ? 'in-progress' : 'empty'
  indexLines.push(
    `| ${s.id} | /knowledge/${s.id} | ${status} | ${now.slice(0, 10)} | ${s.fileCount} files |`
  )
}

indexLines.push('', '## active', 'working-on: (fill this in)', '')

writeFileSync(join(knowledgePath, 'INDEX.md'), indexLines.join('\n'))

// Crea .claude-bridge config si no existe
const bridgePath = join(repoPath, '.claude-bridge')
if (!existsSync(bridgePath)) {
  const bridgeConfig = [
    `project: ${projectId}`,
    'mcp_server: http://localhost:3456',
    'knowledge_path: ./knowledge',
    'watcher:',
    '  watch: ./src',
    '  extensions: [.ts, .tsx, .sql, .prisma]',
    '  section_mapping:',
    '    src/db: database',
    '    src/database: database',
    '    src/api: api',
    '    src/routes: api',
    '    src/auth: auth',
    '    src/middleware: auth',
    '    src/components: frontend',
    '    src/app: frontend',
    '    src/services: services',
    '    src/lib: services',
    '',
  ].join('\n')
  writeFileSync(bridgePath, bridgeConfig)
  console.log(`\n📝 Created .claude-bridge`)
}

console.log(`\n✅ Bootstrap complete!`)
console.log(`   Sections: ${sections.map(s => `${s.id} (${s.fileCount} files)`).join(', ')}`)
console.log(`\n   Next steps:`)
console.log(`   1. Edit knowledge/INDEX.md — fill in stack and working-on`)
console.log(`   2. Edit knowledge/{section}.md — add narrative context`)
console.log(`   3. Run: bun run dev`)
console.log(`   4. Configure Claude Code: claude mcp add --transport http claude-bridge http://localhost:3456\n`)
