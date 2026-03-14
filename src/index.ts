// Entry point — arranca el MCP server HTTP

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server.ts'
import { startWatcher } from './watcher.ts'
import { getHealth } from './health.ts'
import { getProject, upsertProject, updateProjectSync, listSections, updateSectionStatus, logSync } from './storage.ts'
import { extractFromFiles, buildSnapshotMd } from './extractor.ts'
import {
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
  validateBearerToken,
  unauthorized,
} from './auth.ts'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

const PORT = Number(process.env.BRIDGE_PORT ?? 3456)
const KNOWLEDGE_BASE = process.env.BRIDGE_KB_PATH ?? join(import.meta.dir, '../data')

// Asegura que el directorio de datos existe
mkdirSync(KNOWLEDGE_BASE, { recursive: true })
mkdirSync(join(import.meta.dir, '../data'), { recursive: true })

// Per-session transport management — each client gets its own transport + server
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

async function createSessionTransport(): Promise<WebStandardStreamableHTTPServerTransport> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      console.log(`[mcp] Session created: ${sessionId}`)
      sessions.set(sessionId, transport)
    },
  })
  const server = createServer()
  await server.connect(transport)
  return transport
}

// CORS headers for all responses
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// POST /snapshot — recibe { project, files[] } del post-commit hook
async function handleSnapshot(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { project?: string; files?: string[] }
    const { project, files } = body

    if (!project || !files || files.length === 0) {
      return Response.json({ error: 'Missing project or files' }, { status: 400 })
    }

    const projectResult = getProject(project)
    if (!projectResult.ok) {
      return Response.json({ error: projectResult.error }, { status: 404 })
    }

    const knowledgePath = projectResult.value.path
    if (!existsSync(knowledgePath)) {
      mkdirSync(knowledgePath, { recursive: true })
    }

    // Resolve files relative to cwd (git hook sends relative paths)
    const absFiles = files.map(f => resolve(f))
    const result = await extractFromFiles(absFiles)

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 500 })
    }

    // Determine which sections are affected by matching against known sections
    const sections = listSections(project)
    const now = new Date().toISOString()
    const updated: string[] = []

    if (Object.values(result.value).some(Boolean)) {
      // If we have section mappings, group by section; otherwise use a single snapshot
      // For now, update any section whose files overlap, or create a general snapshot
      let targetSection = 'architecture'

      for (const section of sections) {
        // Simple heuristic: if any file path contains the section name, use that section
        if (absFiles.some(f => f.toLowerCase().includes(section.id))) {
          targetSection = section.id
          break
        }
      }

      const snapshotContent = buildSnapshotMd(targetSection, result.value, now)
      writeFileSync(join(knowledgePath, `${targetSection}.snap.md`), snapshotContent, 'utf-8')
      updateSectionStatus(project, targetSection, 'in-progress')
      logSync(project, targetSection, 'snapshot', 'hook')
      updated.push(targetSection)
    }

    updateProjectSync(project, now)

    return Response.json({ success: true, updated, timestamp: now })
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 })
  }
}

// HTTP server con rutas MCP + health
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // ---- OAuth 2.1 endpoints (no auth required) ----

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return withCors(handleProtectedResourceMetadata(req))
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return withCors(handleAuthServerMetadata(req))
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      return withCors(await handleRegister(req))
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      return handleAuthorize(req)
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      return withCors(await handleToken(req))
    }

    // ---- Public endpoints ----

    if (url.pathname === '/health') {
      const health = getHealth()
      return withCors(new Response(JSON.stringify(health), {
        headers: { 'Content-Type': 'application/json' },
        status: health.status === 'unhealthy' ? 503 : 200,
      }))
    }

    if (url.pathname === '/snapshot' && req.method === 'POST') {
      return withCors(await handleSnapshot(req))
    }

    // ---- MCP endpoint (multi-session, auth required for remote) ----

    if (url.pathname === '/mcp') {
      // Auth: skip for localhost, require Bearer for remote
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      if (!isLocal && !validateBearerToken(req)) {
        return withCors(unauthorized(req))
      }

      // Route to existing session or create new one
      const sessionId = req.headers.get('mcp-session-id')

      if (sessionId) {
        const existing = sessions.get(sessionId)
        if (existing) {
          return withCors(await existing.handleRequest(req))
        }
        // Unknown session — return 404 per spec
        return withCors(new Response(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found' },
          id: null,
        }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
      }

      // No session ID — must be an initialize request, create new session
      const transport = await createSessionTransport()
      return withCors(await transport.handleRequest(req))
    }

    return withCors(new Response('Not found', { status: 404 }))
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
