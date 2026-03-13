// Entry point — arranca el MCP server HTTP

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.ts'
import { startWatcher } from './watcher.ts'
import { getHealth } from './health.ts'
import { upsertProject } from './storage.ts'
import { mkdirSync } from 'fs'
import { join } from 'path'

const PORT = Number(process.env.BRIDGE_PORT ?? 3456)
const KNOWLEDGE_BASE = process.env.BRIDGE_KB_PATH ?? join(import.meta.dir, '../data')

// Asegura que el directorio de datos existe
mkdirSync(KNOWLEDGE_BASE, { recursive: true })
mkdirSync(join(import.meta.dir, '../data'), { recursive: true })

const mcpServer = createServer()

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
})

await mcpServer.connect(transport)

// HTTP server con rutas MCP + health
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)

    // Health check endpoint — para monitoring externo
    if (url.pathname === '/health') {
      const health = getHealth()
      return new Response(JSON.stringify(health), {
        headers: { 'Content-Type': 'application/json' },
        status: health.status === 'unhealthy' ? 503 : 200,
      })
    }

    // MCP endpoint
    if (url.pathname === '/mcp' || url.pathname === '/') {
      return transport.handleRequest(req)
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`\n🌉 claude-bridge running on http://localhost:${PORT}`)
console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`)
console.log(`   Health check: http://localhost:${PORT}/health\n`)

// Arranca el watcher si se especifica un repo a vigilar
const watchRepo = process.env.BRIDGE_WATCH_REPO
const watchProject = process.env.BRIDGE_WATCH_PROJECT

if (watchRepo && watchProject) {
  // Registra el proyecto en la DB
  upsertProject({
    id: watchProject,
    path: join(watchRepo, process.env.BRIDGE_KB_RELATIVE_PATH ?? 'knowledge'),
    lastSync: new Date().toISOString(),
  })
  startWatcher(watchRepo, watchProject)
  console.log(`👁  Watching: ${watchRepo} (project: ${watchProject})`)
}

// Manejo de señales para shutdown limpio
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down...')
  process.exit(0)
})
