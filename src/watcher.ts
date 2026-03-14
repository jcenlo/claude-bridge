// File watcher — detecta cambios en el código y regenera snapshots
// Usa Chokidar v4 (ESM-only)

import chokidar from 'chokidar'
import { join, relative as relativePath } from 'path'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { listProjects, updateProjectSync, updateSectionStatus, logSync } from './storage.ts'
import { extractFromFiles, buildSnapshotMd } from './extractor.ts'
import { pingWatcher, setWatcherActive } from './health.ts'
import type { ClaudeBridgeConfig } from './types.ts'

// Carga la config .claude-bridge de un repo
function loadBridgeConfig(repoPath: string): ClaudeBridgeConfig | null {
  const configPath = join(repoPath, '.claude-bridge')
  if (!existsSync(configPath)) return null
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return parseSimpleYaml(raw) as unknown as ClaudeBridgeConfig
  } catch {
    return null
  }
}

// Determina a qué sección pertenece un archivo según el mapping del .claude-bridge
function resolveSection(
  filePath: string,
  repoRoot: string,
  mapping: Record<string, string>
): string | null {
  const rel = filePath.replace(repoRoot + '/', '')
  for (const [glob, section] of Object.entries(mapping)) {
    // Matching simple de prefijo para v1
    // En v2 usar micromatch para soporte completo de globs
    const prefix = glob.replace('/**', '').replace('/*', '')
    if (rel.startsWith(prefix)) return section
  }
  return null
}

// Actualiza el campo last_sync en INDEX.md
function updateIndexSync(knowledgePath: string, lastSync: string): void {
  const indexPath = join(knowledgePath, 'INDEX.md')
  if (!existsSync(indexPath)) return

  const content = readFileSync(indexPath, 'utf-8')
  const updated = content.replace(
    /^> last_sync: .+$/m,
    `> last_sync: ${lastSync}`
  )
  writeFileSync(indexPath, updated, 'utf-8')
}

export function startWatcher(repoPath: string, projectId: string): void {
  const config = loadBridgeConfig(repoPath)
  if (!config) {
    console.warn(`[watcher] No .claude-bridge found in ${repoPath}`)
    return
  }

  const watchDir = join(repoPath, config.watcher.watch)
  const extensions = config.watcher.extensions
  const knowledgePath = join(repoPath, config.knowledgePath)

  const watcher = chokidar.watch(watchDir, {
    ignored: /(node_modules|\.git|dist|\.next)/,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 800,
      pollInterval: 100,
    },
  })

  setWatcherActive(true)

  // Heartbeat cada 5 minutos — confirma que el watcher sigue vivo
  const heartbeatInterval = setInterval(() => {
    const now = new Date().toISOString()
    updateIndexSync(knowledgePath, now)
    updateProjectSync(projectId, now)
    pingWatcher()
  }, 5 * 60 * 1000)

  watcher.on('change', async (filePath) => {
    const ext = '.' + filePath.split('.').pop()
    if (!extensions.includes(ext)) return

    const section = resolveSection(filePath, repoPath, config.watcher.sectionMapping)
    if (!section) return

    console.log(`[watcher] ${relativePath(repoPath, filePath)} → section: ${section}`)

    // Extrae artefactos del archivo modificado
    const result = await extractFromFiles([filePath])
    if (!result.ok) {
      console.error(`[watcher] Extraction failed: ${result.error}`)
      return
    }

    const now = new Date().toISOString()
    const snapshotContent = buildSnapshotMd(section, result.value, now)
    const snapshotPath = join(knowledgePath, `${section}.snap.md`)

    writeFileSync(snapshotPath, snapshotContent, 'utf-8')
    updateIndexSync(knowledgePath, now)
    updateProjectSync(projectId, now)
    updateSectionStatus(projectId, section, 'in-progress')
    logSync(projectId, section, 'snapshot', 'watcher')
    pingWatcher()

    console.log(`[watcher] Snapshot updated: ${section}.snap.md`)
  })

  watcher.on('error', (error) => {
    console.error('[watcher] Error:', error)
    setWatcherActive(false)
  })

  process.on('SIGTERM', () => {
    clearInterval(heartbeatInterval)
    watcher.close()
    setWatcherActive(false)
  })

  console.log(`[watcher] Watching ${watchDir}`)
}

// Parser mínimo de YAML para .claude-bridge
// Soporta hasta 3 niveles de nesting (project, watcher.watch, watcher.section_mapping.*)
// Convierte snake_case keys → camelCase para alinear con ClaudeBridgeConfig
function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'))

  // Stack: [{ obj, indent }] — tracks nesting
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: result, indent: -1 },
  ]

  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    const content = line.trim()
    if (!content.includes(':')) continue

    const colonIdx = content.indexOf(':')
    const key = toCamelCase(content.slice(0, colonIdx).trim())
    const value = content.slice(colonIdx + 1).trim()

    // Pop stack to find parent at correct indent level
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]!.obj

    if (value) {
      // key: value
      parent[key] = parseYamlValue(value)
    } else {
      // key: (new nested object)
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ obj: child, indent })
    }
  }

  return result
}

// snake_case → camelCase: section_mapping → sectionMapping
function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

// Parsea valores YAML simples: strings, arrays inline [a, b, c]
function parseYamlValue(raw: string): unknown {
  const arrayMatch = raw.match(/^\[(.+)]$/)
  if (arrayMatch) {
    return (arrayMatch[1] ?? '').split(',').map(s => s.trim())
  }
  return raw
}
