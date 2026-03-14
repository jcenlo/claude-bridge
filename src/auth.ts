// Minimal OAuth 2.1 Authorization Server for Claude.ai MCP integration
// Implements: Dynamic Client Registration, Authorization Code + PKCE, Token exchange
// All state is in-memory — tokens survive until server restart

// ---- In-memory stores ----

interface RegisteredClient {
  clientId: string
  clientSecret: string
  redirectUris: string[]
  clientName?: string
  grantTypes: string[]
  responseTypes: string[]
  registeredAt: number
}

interface AuthCode {
  code: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
  resource?: string
  state?: string
  expiresAt: number
}

interface AccessToken {
  token: string
  clientId: string
  scope: string
  expiresAt: number
}

const clients = new Map<string, RegisteredClient>()
const authCodes = new Map<string, AuthCode>()
const accessTokens = new Map<string, AccessToken>()

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---- Route handlers ----

// Returns the server's base URL from the request (handles tunnel URLs)
function getBaseUrl(req: Request): string {
  const url = new URL(req.url)

  // Detect Cloudflare tunnel: Cf-Visitor header contains {"scheme":"https"}
  const cfVisitor = req.headers.get('cf-visitor')
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const host = req.headers.get('host') ?? url.host

  let proto = url.protocol.replace(':', '')
  if (forwardedProto) proto = forwardedProto
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: string }
      if (parsed.scheme) proto = parsed.scheme
    } catch { /* ignore */ }
  }

  return `${proto}://${host}`
}

// GET /.well-known/oauth-protected-resource
export function handleProtectedResourceMetadata(req: Request): Response {
  const base = getBaseUrl(req)
  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
    resource_name: 'claude-bridge',
  })
}

// GET /.well-known/oauth-authorization-server
export function handleAuthServerMetadata(req: Request): Response {
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

// POST /register — Dynamic Client Registration (RFC 7591)
export async function handleRegister(req: Request): Promise<Response> {
  try {
    const body = await req.json() as Record<string, unknown>

    const clientId = generateId()
    const clientSecret = generateId()

    const client: RegisteredClient = {
      clientId,
      clientSecret,
      redirectUris: (body.redirect_uris as string[]) ?? [],
      clientName: body.client_name as string | undefined,
      grantTypes: (body.grant_types as string[]) ?? ['authorization_code'],
      responseTypes: (body.response_types as string[]) ?? ['code'],
      registeredAt: Date.now(),
    }

    clients.set(clientId, client)
    console.log(`[auth] Registered client: ${client.clientName ?? clientId}`)

    return Response.json({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(client.registeredAt / 1000),
      client_secret_expires_at: 0,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      client_name: client.clientName,
      token_endpoint_auth_method: 'client_secret_post',
    }, { status: 201 })
  } catch (e) {
    return Response.json({
      error: 'invalid_client_metadata',
      error_description: String(e),
    }, { status: 400 })
  }
}

// GET /authorize — Authorization endpoint
// Auto-approves and redirects back with code (dev mode)
export function handleAuthorize(req: Request): Response {
  const url = new URL(req.url)
  const clientId = url.searchParams.get('client_id')
  const redirectUri = url.searchParams.get('redirect_uri')
  const responseType = url.searchParams.get('response_type')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'S256'
  const state = url.searchParams.get('state')
  const scope = url.searchParams.get('scope') ?? 'mcp:tools'
  const resource = url.searchParams.get('resource')

  if (!clientId || !redirectUri || responseType !== 'code') {
    return Response.json({
      error: 'invalid_request',
      error_description: 'Missing required parameters',
    }, { status: 400 })
  }

  if (!codeChallenge) {
    return Response.json({
      error: 'invalid_request',
      error_description: 'PKCE code_challenge is required',
    }, { status: 400 })
  }

  // Generate authorization code
  const code = generateId()
  authCodes.set(code, {
    code,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    resource: resource ?? undefined,
    state: state ?? undefined,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  })

  console.log(`[auth] Authorization code issued for client ${clientId}`)

  // Redirect back to client with code
  const redirect = new URL(redirectUri)
  redirect.searchParams.set('code', code)
  if (state) redirect.searchParams.set('state', state)

  return Response.redirect(redirect.toString(), 302)
}

// POST /token — Token exchange
export async function handleToken(req: Request): Promise<Response> {
  const body = await req.text()
  const params = new URLSearchParams(body)

  const grantType = params.get('grant_type')
  const code = params.get('code')
  const codeVerifier = params.get('code_verifier')
  const clientId = params.get('client_id')
  const redirectUri = params.get('redirect_uri')

  if (grantType !== 'authorization_code') {
    return Response.json({
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grantType}' not supported`,
    }, { status: 400 })
  }

  if (!code || !clientId) {
    return Response.json({
      error: 'invalid_request',
      error_description: 'Missing code or client_id',
    }, { status: 400 })
  }

  const authCode = authCodes.get(code)
  if (!authCode) {
    return Response.json({
      error: 'invalid_grant',
      error_description: 'Authorization code not found or already used',
    }, { status: 400 })
  }

  // Delete code immediately (single use)
  authCodes.delete(code)

  // Validate expiry
  if (Date.now() > authCode.expiresAt) {
    return Response.json({
      error: 'invalid_grant',
      error_description: 'Authorization code expired',
    }, { status: 400 })
  }

  // Validate client
  if (authCode.clientId !== clientId) {
    return Response.json({
      error: 'invalid_grant',
      error_description: 'Client mismatch',
    }, { status: 400 })
  }

  // Validate redirect URI
  if (redirectUri && authCode.redirectUri !== redirectUri) {
    return Response.json({
      error: 'invalid_grant',
      error_description: 'Redirect URI mismatch',
    }, { status: 400 })
  }

  // PKCE verification
  if (codeVerifier) {
    const computed = await sha256Base64Url(codeVerifier)
    if (computed !== authCode.codeChallenge) {
      return Response.json({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      }, { status: 400 })
    }
  }

  // Issue access token
  const accessToken = generateId() + generateId()
  const expiresIn = 3600 * 24 // 24 hours
  accessTokens.set(accessToken, {
    token: accessToken,
    clientId,
    scope: authCode.scope,
    expiresAt: Date.now() + expiresIn * 1000,
  })

  console.log(`[auth] Access token issued for client ${clientId}`)

  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: authCode.scope,
  })
}

// ---- Token validation ----

export function validateBearerToken(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  const stored = accessTokens.get(token)
  if (!stored) return false
  if (Date.now() > stored.expiresAt) {
    accessTokens.delete(token)
    return false
  }

  return true
}

// Returns 401 response with proper WWW-Authenticate header
export function unauthorized(req: Request): Response {
  const base = getBaseUrl(req)
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    },
  })
}
