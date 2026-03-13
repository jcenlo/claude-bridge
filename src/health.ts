// Heartbeat y health check del servidor
// Integration test verified — paso 5 final

import { listProjects, listSections } from './storage.ts'
import type { HealthOutput, HealthStatus } from './types.ts'

const START_TIME = Date.now()

// Estado del watcher — lo actualiza watcher.ts
let watcherActive = false
let lastWatcherPing = Date.now()

export function setWatcherActive(active: boolean): void {
  watcherActive = active
  if (active) lastWatcherPing = Date.now()
}

export function pingWatcher(): void {
  lastWatcherPing = Date.now()
  watcherActive = true
}

export function isWatcherStale(): boolean {
  const MAX_SILENCE_MS = 30 * 60 * 1000 // 30 minutos
  return Date.now() - lastWatcherPing > MAX_SILENCE_MS
}

export function getHealth(): HealthOutput {
  const projects = listProjects()
  let sectionsTotal = 0
  let sectionsOutdated = 0
  let lastSync = ''

  for (const project of projects) {
    const sections = listSections(project.id)
    sectionsTotal += sections.length
    sectionsOutdated += sections.filter(s => s.status === 'outdated').length
    if (!lastSync || project.lastSync > lastSync) lastSync = project.lastSync
  }

  const watcherOk = watcherActive && !isWatcherStale()
  let status: HealthStatus = 'healthy'

  if (!watcherOk && projects.length > 0) status = 'degraded'
  if (sectionsOutdated > sectionsTotal * 0.5) status = 'degraded'

  return {
    status,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    lastSync: lastSync || new Date().toISOString(),
    watcherActive: watcherOk,
    projects: projects.length,
    sectionsTotal,
    sectionsOutdated,
  }
}

// Genera el warning de heartbeat para session_init
export function getSyncWarning(lastSync: string): string | undefined {
  const lastSyncMs = new Date(lastSync).getTime()
  const diffMin = Math.floor((Date.now() - lastSyncMs) / 60000)

  if (diffMin > 30) {
    return `⚠️ watcher sin respuesta desde hace ${diffMin} minutos — snapshots pueden estar desactualizados`
  }
  return undefined
}
