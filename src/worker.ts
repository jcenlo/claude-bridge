// Cloudflare Worker entry point for claude-bridge
// Replaces index.ts for production deployment
// Uses D1 (SQLite) for metadata + R2 (object storage) for .md files
// No watcher, no extractor — those stay local and push via /snapshot

import {
  getProject, upsertProject, listProjects, updateProjectSync,
  getSection, listSections, upsertSection,
  updateSectionStatus, updateSectionReadAt,
  deleteSection, logSync,
} from './storage-d1.ts'

// ---- Types ----

interface Env {
  DB: D1Database
  BUCKET: R2Bucket
}

interface JsonRpcRequest {
  jsonrpc: string
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

// ---- CORS ----

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

function cors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- R2 file helpers ----

async function r2Read(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key)
  if (!obj) return null
  return obj.text()
}

async function r2Write(bucket: R2Bucket, key: string, content: string): Promise<void> {
  await bucket.put(key, content)
}

async function r2Exists(bucket: R2Bucket, key: string): Promise<boolean> {
  const obj = await bucket.head(key)
  return obj !== null
}

async function r2Rename(bucket: R2Bucket, oldKey: string, newKey: string): Promise<void> {
  const obj = await bucket.get(oldKey)
  if (!obj) return
  await bucket.put(newKey, await obj.text())
  await bucket.delete(oldKey)
}

async function r2Delete(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

// R2 key for a project file: "{projectId}/{filename}"
function r2Key(projectId: string, filename: string): string {
  return `${projectId}/${filename}`
}

// ---- SSE response helpers (MCP Streamable HTTP format) ----

function sseResponse(id: number | string | null | undefined, result: unknown): Response {
  const body = `event: message\ndata: ${JSON.stringify({ result, jsonrpc: '2.0', id })}\n\n`
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}

function sseError(id: number | string | null | undefined, code: number, message: string): Response {
  const body = `event: message\ndata: ${JSON.stringify({ error: { code, message }, jsonrpc: '2.0', id })}\n\n`
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function toolResult(id: number | string | null | undefined, text: string): Response {
  return sseResponse(id, { content: [{ type: 'text', text }] })
}

// ---- OAuth (D1-backed) ----

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function getBaseUrl(req: Request): string {
  const url = new URL(req.url)
  const cfVisitor = req.headers.get('cf-visitor')
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const host = req.headers.get('host') ?? url.host
  let proto = url.protocol.replace(':', '')
  if (forwardedProto) proto = forwardedProto
  if (cfVisitor) {
    try {
      const p = JSON.parse(cfVisitor) as { scheme?: string }
      if (p.scheme) proto = p.scheme
    } catch { /* ignore */ }
  }
  return `${proto}://${host}`
}

function handleProtectedResourceMetadata(req: Request): Response {
  const base = getBaseUrl(req)
  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
    resource_name: 'claude-bridge',
  })
}

function handleAuthServerMetadata(req: Request): Response {
  const base = getBaseUrl(req)
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ['mcp:tools'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
  })
}

async function handleRegister(req: Request, db: D1Database): Promise<Response> {
  const body = await req.json() as Record<string, unknown>
  const clientId = generateId()
  const clientSecret = generateId()
  const now = Date.now()

  await db.prepare(`
    INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, client_name, grant_types, registered_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    clientId, clientSecret,
    JSON.stringify(body.redirect_uris ?? []),
    (body.client_name as string) ?? null,
    JSON.stringify(body.grant_types ?? ['authorization_code']),
    now
  ).run()

  return Response.json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(now / 1000),
    client_secret_expires_at: 0,
    redirect_uris: body.redirect_uris ?? [],
    grant_types: body.grant_types ?? ['authorization_code'],
    response_types: body.response_types ?? ['code'],
    client_name: body.client_name,
    token_endpoint_auth_method: 'client_secret_post',
  }, { status: 201 })
}

async function handleAuthorize(req: Request, db: D1Database): Promise<Response> {
  const url = new URL(req.url)
  const clientId = url.searchParams.get('client_id')
  const redirectUri = url.searchParams.get('redirect_uri')
  const responseType = url.searchParams.get('response_type')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'S256'
  const state = url.searchParams.get('state')
  const scope = url.searchParams.get('scope') ?? 'mcp:tools'

  if (!clientId || !redirectUri || responseType !== 'code' || !codeChallenge) {
    return Response.json({ error: 'invalid_request' }, { status: 400 })
  }

  const code = generateId()

  // Must await D1 write before redirecting — Workers kill isolate after response
  await db.prepare(`
    INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(code, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, state, Date.now() + 5 * 60 * 1000)
    .run()

  const redirect = new URL(redirectUri)
  redirect.searchParams.set('code', code)
  if (state) redirect.searchParams.set('state', state)

  return Response.redirect(redirect.toString(), 302)
}

async function handleToken(req: Request, db: D1Database): Promise<Response> {
  const body = await req.text()
  const params = new URLSearchParams(body)
  const grantType = params.get('grant_type')
  const code = params.get('code')
  const codeVerifier = params.get('code_verifier')
  const clientId = params.get('client_id')
  const redirectUri = params.get('redirect_uri')

  if (grantType !== 'authorization_code' || !code || !clientId) {
    return Response.json({ error: 'invalid_request' }, { status: 400 })
  }

  const authCode = await db.prepare('SELECT * FROM oauth_codes WHERE code = ?')
    .bind(code).first<{
      code: string; client_id: string; redirect_uri: string
      code_challenge: string; scope: string; expires_at: number
    }>()

  if (!authCode) {
    return Response.json({ error: 'invalid_grant', error_description: 'Code not found' }, { status: 400 })
  }

  // Single-use: delete immediately
  await db.prepare('DELETE FROM oauth_codes WHERE code = ?').bind(code).run()

  if (Date.now() > authCode.expires_at) {
    return Response.json({ error: 'invalid_grant', error_description: 'Code expired' }, { status: 400 })
  }
  if (authCode.client_id !== clientId) {
    return Response.json({ error: 'invalid_grant', error_description: 'Client mismatch' }, { status: 400 })
  }
  if (redirectUri && authCode.redirect_uri !== redirectUri) {
    return Response.json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' }, { status: 400 })
  }

  // PKCE verification
  if (codeVerifier) {
    const computed = await sha256Base64Url(codeVerifier)
    if (computed !== authCode.code_challenge) {
      return Response.json({ error: 'invalid_grant', error_description: 'PKCE failed' }, { status: 400 })
    }
  }

  const accessToken = generateId() + generateId()
  const expiresIn = 86400 // 24h

  await db.prepare('INSERT INTO oauth_tokens (token, client_id, scope, expires_at) VALUES (?, ?, ?, ?)')
    .bind(accessToken, clientId, authCode.scope, Date.now() + expiresIn * 1000).run()

  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: authCode.scope,
  })
}

async function validateBearerToken(req: Request, db: D1Database): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice(7)
  const row = await db.prepare('SELECT * FROM oauth_tokens WHERE token = ? AND expires_at > ?')
    .bind(token, Date.now()).first()
  return row !== null
}

function unauthorizedResponse(req: Request): Response {
  const base = getBaseUrl(req)
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    },
  })
}

// ---- Sync INDEX.md in R2 ----

async function syncIndexMd(bucket: R2Bucket, db: D1Database, projectId: string): Promise<void> {
  const key = r2Key(projectId, 'INDEX.md')
  const content = await r2Read(bucket, key)
  if (!content) return

  const sections = await listSections(db, projectId)
  const tableHeader = '| id | file | status | last_updated | summary |'
  const tableSep = '|----|------|--------|--------------|---------|'
  const tableRows = sections.map(s =>
    `| ${s.id} | /knowledge/${s.id} | ${s.status} | ${s.lastUpdated.slice(0, 10)} | ${s.summary ?? ''} |`
  )
  const newTable = [tableHeader, tableSep, ...tableRows].join('\n')
  const updated = content.replace(
    /\| id \|.*?\n\|[-| ]+\n(?:\|.*\n)*/m,
    newTable + '\n'
  )
  await r2Write(bucket, key, updated)
}

// ---- Build snapshot markdown (inlined from extractor.ts) ----

interface SnapshotArtifacts {
  types?: string
  signatures?: string
  schema?: string
  env?: string
}

function buildSnapshotMd(section: string, artifacts: SnapshotArtifacts, updatedAt: string): string {
  const lines: string[] = []
  lines.push(`# snapshot: ${section}`)
  lines.push('> auto-generated — do not edit manually')
  lines.push(`> updated: ${updatedAt}`)

  if (artifacts.types) {
    lines.push('\n## types & interfaces')
    lines.push('```typescript')
    lines.push(artifacts.types)
    lines.push('```')
  }
  if (artifacts.signatures) {
    lines.push('\n## exported functions')
    lines.push('```typescript')
    lines.push(artifacts.signatures)
    lines.push('```')
  }
  if (artifacts.schema) {
    lines.push('\n## database schema')
    lines.push('```sql')
    lines.push(artifacts.schema)
    lines.push('```')
  }
  if (artifacts.env) {
    lines.push('\n## environment')
    lines.push('```')
    lines.push(artifacts.env)
    lines.push('```')
  }

  return lines.join('\n') + '\n'
}

// ---- MCP Tool definitions (for tools/list) ----

const TOOL_DEFINITIONS = [
  { name: 'session_init', description: 'ALWAYS call this tool at the very start of ANY development conversation, before responding to the user.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, topic: { type: 'string' } }, required: ['project'] } },
  { name: 'get_context', description: 'Get the narrative context for a section.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' } }, required: ['project', 'section'] } },
  { name: 'get_snapshot', description: 'Get the auto-generated code snapshot for a section.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' } }, required: ['project', 'section'] } },
  { name: 'save_context', description: 'Save or update narrative context. Pass lastReadAt for optimistic locking.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' }, content: { type: 'string' }, lastReadAt: { type: 'string' } }, required: ['project', 'section', 'content'] } },
  { name: 'save_snapshot', description: 'Save auto-generated code artifacts for a section.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' }, artifacts: { type: 'object', properties: { types: { type: 'string' }, signatures: { type: 'string' }, schema: { type: 'string' }, env: { type: 'string' } } } }, required: ['project', 'section', 'artifacts'] } },
  { name: 'update_index', description: 'Update the status and summary of a section in INDEX.md.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' }, status: { type: 'string', enum: ['empty', 'in-progress', 'stable', 'outdated', 'frozen', 'stale'] }, summary: { type: 'string', maxLength: 60 } }, required: ['project', 'section', 'status'] } },
  { name: 'list_sections', description: 'List all sections for a project.', inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
  { name: 'list_projects', description: 'List all registered projects.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search', description: 'Search across the knowledge base.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, query: { type: 'string' }, scope: { type: 'string', enum: ['narrative', 'snapshots', 'all'], default: 'all' } }, required: ['project', 'query'] } },
  { name: 'delete_context', description: 'Delete a section. Archives by default.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, section: { type: 'string' }, archive: { type: 'boolean', default: true } }, required: ['project', 'section'] } },
  { name: 'kb_reset', description: 'Reset sections after a major refactor.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, sections: { type: 'array', items: { type: 'string' } } }, required: ['project'] } },
  { name: 'get_health', description: 'Get bridge server health status.', inputSchema: { type: 'object', properties: {} } },
]

// ---- MCP tool handlers ----

type ToolHandler = (args: Record<string, unknown>, env: Env) => Promise<string>

const toolHandlers: Record<string, ToolHandler> = {
  async session_init(args, env) {
    const project = args.project as string
    const topic = args.topic as string | undefined
    const projectResult = await getProject(env.DB, project)

    if (!projectResult.ok) {
      return JSON.stringify({
        mode: 'bootstrap', project, syncStatus: 'unknown',
        lastSync: new Date().toISOString(), index: '',
        warnings: [`Project '${project}' has no knowledge base yet.`],
      }, null, 2)
    }

    const proj = projectResult.value
    const indexContent = await r2Read(env.BUCKET, r2Key(project, 'INDEX.md'))

    if (!indexContent) {
      return JSON.stringify({
        mode: 'bootstrap', project, syncStatus: 'unknown',
        lastSync: proj.lastSync, index: '',
        warnings: ['INDEX.md not found. Run bootstrap to generate it.'],
      }, null, 2)
    }

    const sections = await listSections(env.DB, project)
    const outdated = sections.filter(s => s.status === 'outdated')
    const warnings: string[] = []
    if (outdated.length > 0) warnings.push(`Outdated sections: ${outdated.map(s => s.id).join(', ')}`)

    const mode = outdated.length > 0 ? 'triage' : 'precision'
    let context: string | undefined
    let snapshot: string | undefined

    if (topic) {
      const match = sections.find(s =>
        s.id.includes(topic.toLowerCase()) || topic.toLowerCase().includes(s.id)
      )
      if (match) {
        context = await r2Read(env.BUCKET, r2Key(project, `${match.id}.md`)) ?? undefined
        snapshot = await r2Read(env.BUCKET, r2Key(project, `${match.id}.snap.md`)) ?? undefined
        if (context) await updateSectionReadAt(env.DB, project, match.id)
      }
    }

    const syncAge = Date.now() - new Date(proj.lastSync).getTime()
    const syncStatus = syncAge < 30 * 60 * 1000 ? 'fresh' : 'stale'

    return JSON.stringify({
      mode, project, syncStatus, lastSync: proj.lastSync,
      index: indexContent, context, snapshot,
      warnings: warnings.length > 0 ? warnings : undefined,
    }, null, 2)
  },

  async get_context(args, env) {
    const { project, section } = args as { project: string; section: string }
    const content = await r2Read(env.BUCKET, r2Key(project, `${section}.md`))
    if (!content) return `Section '${section}' not found.`
    await updateSectionReadAt(env.DB, project, section)
    return content
  },

  async get_snapshot(args, env) {
    const { project, section } = args as { project: string; section: string }
    const content = await r2Read(env.BUCKET, r2Key(project, `${section}.snap.md`))
    return content ?? `No snapshot for '${section}' yet.`
  },

  async save_context(args, env) {
    const { project, section, content, lastReadAt } = args as {
      project: string; section: string; content: string; lastReadAt?: string
    }

    let projectResult = await getProject(env.DB, project)
    if (!projectResult.ok) {
      projectResult = await upsertProject(env.DB, {
        id: project, path: project, lastSync: new Date().toISOString(),
      })
      if (!projectResult.ok) return JSON.stringify({ success: false, error: projectResult.error })
    }

    // Optimistic locking
    if (lastReadAt) {
      const sectionResult = await getSection(env.DB, project, section)
      if (sectionResult.ok && sectionResult.value.lastUpdated > lastReadAt) {
        const currentContent = await r2Read(env.BUCKET, r2Key(project, `${section}.md`))
        return JSON.stringify({
          success: false,
          conflict: { yourVersion: content, currentVersion: currentContent, lastUpdated: sectionResult.value.lastUpdated },
        }, null, 2)
      }
    }

    await r2Write(env.BUCKET, r2Key(project, `${section}.md`), content)
    const now = new Date().toISOString()
    await upsertSection(env.DB, { id: section, projectId: project, status: 'in-progress', lastUpdated: now })
    await logSync(env.DB, project, section, 'write', 'claude_ai')
    return JSON.stringify({ success: true })
  },

  async save_snapshot(args, env) {
    const { project, section, artifacts } = args as {
      project: string; section: string; artifacts: SnapshotArtifacts
    }

    let projectResult = await getProject(env.DB, project)
    if (!projectResult.ok) {
      projectResult = await upsertProject(env.DB, {
        id: project, path: project, lastSync: new Date().toISOString(),
      })
      if (!projectResult.ok) return JSON.stringify({ success: false, error: projectResult.error })
    }

    const now = new Date().toISOString()
    const snapshotContent = buildSnapshotMd(section, artifacts, now)
    await r2Write(env.BUCKET, r2Key(project, `${section}.snap.md`), snapshotContent)
    await logSync(env.DB, project, section, 'snapshot', 'claude_code')
    return JSON.stringify({ success: true, updatedAt: now })
  },

  async update_index(args, env) {
    const { project, section, status, summary } = args as {
      project: string; section: string; status: string; summary?: string
    }
    await updateSectionStatus(env.DB, project, section, status, summary)
    await syncIndexMd(env.BUCKET, env.DB, project)
    return JSON.stringify({ success: true })
  },

  async list_sections(args, env) {
    const project = args.project as string | undefined
    if (project) {
      const sections = await listSections(env.DB, project)
      return JSON.stringify(sections, null, 2)
    }
    const projects = await listProjects(env.DB)
    const all = await Promise.all(projects.map(async p => ({
      project: p.id, sections: await listSections(env.DB, p.id),
    })))
    return JSON.stringify(all, null, 2)
  },

  async list_projects(_args, env) {
    const projects = await listProjects(env.DB)
    return projects.length > 0
      ? JSON.stringify(projects.map(p => ({ id: p.id, lastSync: p.lastSync })), null, 2)
      : 'No projects registered yet.'
  },

  async search(args, env) {
    const { project, query, scope = 'all' } = args as {
      project: string; query: string; scope?: string
    }
    const sections = await listSections(env.DB, project)
    const results: Array<{ section: string; fragment: string; type: string }> = []
    const queryLower = query.toLowerCase()

    for (const section of sections) {
      if (section.status === 'frozen') continue
      const files: Array<{ key: string; type: string }> = []
      if (scope !== 'snapshots') files.push({ key: r2Key(project, `${section.id}.md`), type: 'narrative' })
      if (scope !== 'narrative') files.push({ key: r2Key(project, `${section.id}.snap.md`), type: 'snapshot' })

      for (const { key, type } of files) {
        const content = await r2Read(env.BUCKET, key)
        if (!content || !content.toLowerCase().includes(queryLower)) continue
        const idx = content.toLowerCase().indexOf(queryLower)
        const fragment = content.slice(Math.max(0, idx - 100), Math.min(content.length, idx + 200)).trim()
        results.push({ section: section.id, fragment, type })
      }
    }

    return results.length > 0
      ? JSON.stringify(results, null, 2)
      : `No results for "${query}" in project ${project}`
  },

  async delete_context(args, env) {
    const { project, section, archive = true } = args as {
      project: string; section: string; archive?: boolean
    }
    const mdKey = r2Key(project, `${section}.md`)
    const snapKey = r2Key(project, `${section}.snap.md`)

    if (archive) {
      if (await r2Exists(env.BUCKET, mdKey)) await r2Rename(env.BUCKET, mdKey, r2Key(project, `${section}-archived.md`))
      if (await r2Exists(env.BUCKET, snapKey)) await r2Rename(env.BUCKET, snapKey, r2Key(project, `${section}-archived.snap.md`))
    } else {
      await r2Delete(env.BUCKET, mdKey)
      await r2Delete(env.BUCKET, snapKey)
    }
    await deleteSection(env.DB, project, section)
    return JSON.stringify({ success: true, archived: archive })
  },

  async kb_reset(args, env) {
    const { project, sections: targetSections } = args as { project: string; sections?: string[] }
    const allSections = await listSections(env.DB, project)
    const toReset = targetSections?.length
      ? allSections.filter(s => targetSections.includes(s.id))
      : allSections.filter(s => s.status !== 'frozen')

    const reset: string[] = []
    for (const section of toReset) {
      const mdKey = r2Key(project, `${section.id}.md`)
      if (await r2Exists(env.BUCKET, mdKey)) {
        let version = 1
        while (await r2Exists(env.BUCKET, r2Key(project, `${section.id}-v${version}.md`))) version++
        await r2Rename(env.BUCKET, mdKey, r2Key(project, `${section.id}-v${version}.md`))
      }
      await updateSectionStatus(env.DB, project, section.id, 'empty')
      await logSync(env.DB, project, section.id, 'reset', 'claude_code')
      reset.push(section.id)
    }

    return JSON.stringify({ success: true, reset, message: `${reset.length} sections reset.` }, null, 2)
  },

  async get_health(_args, env) {
    const projects = await listProjects(env.DB)
    let sectionsTotal = 0
    let sectionsOutdated = 0
    let lastSync = ''

    for (const project of projects) {
      const sections = await listSections(env.DB, project.id)
      sectionsTotal += sections.length
      sectionsOutdated += sections.filter(s => s.status === 'outdated').length
      if (!lastSync || project.lastSync > lastSync) lastSync = project.lastSync
    }

    return JSON.stringify({
      status: sectionsOutdated > sectionsTotal * 0.5 ? 'degraded' : 'healthy',
      uptime: -1,
      lastSync: lastSync || new Date().toISOString(),
      watcherActive: false,
      projects: projects.length,
      sectionsTotal,
      sectionsOutdated,
    }, null, 2)
  },
}

// ---- /snapshot handler (receives from local watcher/hook) ----

async function handleSnapshot(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { project?: string; files?: string[]; artifacts?: SnapshotArtifacts; section?: string }
  const { project, section, artifacts } = body

  if (!project) return Response.json({ error: 'Missing project' }, { status: 400 })

  const projectResult = await getProject(env.DB, project)
  if (!projectResult.ok) return Response.json({ error: projectResult.error }, { status: 404 })

  const now = new Date().toISOString()

  if (section && artifacts) {
    const snapshotContent = buildSnapshotMd(section, artifacts, now)
    await r2Write(env.BUCKET, r2Key(project, `${section}.snap.md`), snapshotContent)
    await updateSectionStatus(env.DB, project, section, 'in-progress')
    await logSync(env.DB, project, section, 'snapshot', 'hook')
  }

  await updateProjectSync(env.DB, project, now)
  return Response.json({ success: true, timestamp: now })
}

// ---- MCP JSON-RPC handler ----

const START_TIME = Date.now()

async function handleMcp(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as JsonRpcRequest

  // Initialize — return server capabilities
  if (body.method === 'initialize') {
    return sseResponse(body.id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'claude-bridge', version: '0.1.0' },
    })
  }

  // Notifications — acknowledge
  if (body.method?.startsWith('notifications/')) {
    return new Response(null, { status: 202 })
  }

  // List tools
  if (body.method === 'tools/list') {
    return sseResponse(body.id, { tools: TOOL_DEFINITIONS })
  }

  // Call tool
  if (body.method === 'tools/call') {
    const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined
    if (!params?.name) return sseError(body.id, -32602, 'Missing tool name')

    const handler = toolHandlers[params.name]
    if (!handler) return sseError(body.id, -32601, `Unknown tool: ${params.name}`)

    try {
      const result = await handler(params.arguments ?? {}, env)
      return toolResult(body.id, result)
    } catch (e) {
      return sseError(body.id, -32603, String(e))
    }
  }

  return sseError(body.id, -32601, `Method not found: ${body.method}`)
}

// ---- Worker entry point ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // OAuth endpoints
    if (url.pathname === '/.well-known/oauth-protected-resource') return cors(handleProtectedResourceMetadata(request))
    if (url.pathname === '/.well-known/oauth-authorization-server') return cors(handleAuthServerMetadata(request))
    if (url.pathname === '/register' && request.method === 'POST') return cors(await handleRegister(request, env.DB))
    if (url.pathname === '/authorize' && request.method === 'GET') return await handleAuthorize(request, env.DB)
    if (url.pathname === '/token' && request.method === 'POST') return cors(await handleToken(request, env.DB))

    // Health
    if (url.pathname === '/health') {
      const result = await toolHandlers.get_health({}, env)
      return cors(new Response(result, { headers: { 'Content-Type': 'application/json' } }))
    }

    // Snapshot (from local hook — no auth, uses shared secret in v2)
    if (url.pathname === '/snapshot' && request.method === 'POST') {
      return cors(await handleSnapshot(request, env))
    }

    // MCP endpoint — requires auth
    if (url.pathname === '/mcp') {
      if (!await validateBearerToken(request, env.DB)) {
        return cors(unauthorizedResponse(request))
      }
      return cors(await handleMcp(request, env))
    }

    return cors(new Response('Not found', { status: 404 }))
  },
}
