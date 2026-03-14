// Extrae tipos, interfaces y firmas de archivos de código
// Principal: ctags | Fallback: ast-grep | Fallback: regex

import { execa } from 'execa'
import { readFileSync, existsSync } from 'fs'
import { relative } from 'path'
import type { Result } from './types.ts'
import { ok, err } from './types.ts'

// Convert absolute path to relative for cleaner snapshots
function relPath(filePath: string): string {
  return relative(process.cwd(), filePath)
}

export interface ExtractedArtifacts {
  types?: string
  signatures?: string
  schema?: string
  env?: string
}

// Detecta si universal-ctags está disponible (no BSD ctags)
let ctagsAvailable: boolean | undefined
async function hasCTags(): Promise<boolean> {
  if (ctagsAvailable !== undefined) return ctagsAvailable
  try {
    const { stdout } = await execa('ctags', ['--version'])
    // BSD ctags (macOS built-in) no soporta --output-format=json
    ctagsAvailable = stdout.includes('Universal Ctags')
  } catch {
    ctagsAvailable = false
  }
  return ctagsAvailable
}

// Detecta si ast-grep (sg) está disponible
let astGrepAvailable: boolean | undefined
async function hasAstGrep(): Promise<boolean> {
  if (astGrepAvailable !== undefined) return astGrepAvailable
  try {
    await execa('sg', ['--version'])
    astGrepAvailable = true
  } catch {
    astGrepAvailable = false
  }
  return astGrepAvailable
}

// Extrae artefactos de un archivo o lista de archivos
export async function extractFromFiles(
  files: string[]
): Promise<Result<ExtractedArtifacts>> {
  const results: ExtractedArtifacts = {}

  const tsFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
  const sqlFiles = files.filter(f => f.endsWith('.sql') || f.endsWith('.prisma'))
  const envFiles = files.filter(f => f.endsWith('.env.example'))

  if (tsFiles.length > 0) {
    const extracted = await extractTypeScript(tsFiles)
    if (extracted.ok) {
      results.types = extracted.value.types
      results.signatures = extracted.value.signatures
    }
  }

  if (sqlFiles.length > 0) {
    const schemas = sqlFiles.map(f => {
      try {
        return `-- ${relPath(f)}\n${readFileSync(f, 'utf-8')}`
      } catch {
        return ''
      }
    }).filter(Boolean)
    if (schemas.length > 0) results.schema = schemas.join('\n\n')
  }

  if (envFiles.length > 0) {
    const envContent = envFiles.map(f => {
      try {
        return readFileSync(f, 'utf-8')
          .split('\n')
          .filter(line => line && !line.startsWith('#'))
          .map(line => line.split('=')[0]?.trim())
          .filter(Boolean)
          .join('\n')
      } catch {
        return ''
      }
    }).filter(Boolean)
    if (envContent.length > 0) results.env = envContent.join('\n')
  }

  return ok(results)
}

type TsExtraction = Pick<ExtractedArtifacts, 'types' | 'signatures'>

async function extractTypeScript(files: string[]): Promise<Result<TsExtraction>> {
  if (await hasCTags()) return extractWithCTags(files)
  if (await hasAstGrep()) return extractWithAstGrep(files)
  return extractWithRegex(files)
}

async function extractWithCTags(files: string[]): Promise<Result<TsExtraction>> {
  try {
    const { stdout } = await execa('ctags', [
      '--output-format=json',
      '--fields=+lnSztK',
      '--extras=+q',
      '--languages=TypeScript',
      ...files,
    ])

    const tags = stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)

    const typeEntries = tags
      .filter((t: Record<string, string>) =>
        ['interface', 'type', 'enum', 'class'].includes(t.kind)
      )
      .map((t: Record<string, string>) => `// ${relPath(t.path)}:${t.line}\n${t.kind} ${t.name}`)

    const funcEntries = tags
      .filter((t: Record<string, string>) =>
        ['function', 'method'].includes(t.kind) && t.access === 'public'
      )
      .map((t: Record<string, string>) => `// ${relPath(t.path)}:${t.line}\nexport function ${t.name}(...)`)

    return ok({
      types: typeEntries.length > 0 ? typeEntries.join('\n\n') : undefined,
      signatures: funcEntries.length > 0 ? funcEntries.join('\n') : undefined,
    })
  } catch (e) {
    return err(`ctags failed: ${e}`)
  }
}

async function extractWithAstGrep(files: string[]): Promise<Result<TsExtraction>> {
  try {
    const { stdout: typeOutput } = await execa('sg', [
      'run',
      '--pattern', 'export $KIND $NAME { $$$BODY }',
      '--json',
      ...files,
    ])

    const { stdout: funcOutput } = await execa('sg', [
      'run',
      '--pattern', 'export function $NAME($$$PARAMS): $RET { $$$BODY }',
      '--json',
      ...files,
    ])

    const parseOutput = (raw: string): string[] => {
      try {
        const results = JSON.parse(raw)
        return results.map((r: Record<string, string>) => r.text ?? '').filter(Boolean)
      } catch { return [] }
    }

    return ok({
      types: parseOutput(typeOutput).join('\n\n') || undefined,
      signatures: parseOutput(funcOutput).join('\n') || undefined,
    })
  } catch (e) {
    return err(`ast-grep failed: ${e}`)
  }
}

// Fallback: regex-based extraction para cuando ni ctags ni ast-grep están disponibles
function extractWithRegex(files: string[]): Result<TsExtraction> {
  const typeLines: string[] = []
  const sigLines: string[] = []

  for (const file of files) {
    if (!existsSync(file)) continue
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const trimmed = line.trim()

      // export interface Foo { ... }
      const ifaceMatch = trimmed.match(/^export\s+(interface|type|enum|class)\s+(\w+)/)
      if (ifaceMatch) {
        // Captura el bloque completo hasta el cierre
        const block = captureBlock(lines, i)
        typeLines.push(`// ${relPath(file)}:${i + 1}\n${block}`)
        continue
      }

      // export function foo(...): ReturnType
      const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*[<(]/)
      if (funcMatch) {
        // Solo la firma, no el cuerpo
        const sig = extractSignature(lines, i)
        sigLines.push(`// ${relPath(file)}:${i + 1}\n${sig}`)
        continue
      }

      // export const foo = (...) => ... (arrow functions)
      const arrowMatch = trimmed.match(/^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(/)
      if (arrowMatch) {
        const sig = extractSignature(lines, i)
        sigLines.push(`// ${relPath(file)}:${i + 1}\n${sig}`)
      }
    }
  }

  return ok({
    types: typeLines.length > 0 ? typeLines.join('\n\n') : undefined,
    signatures: sigLines.length > 0 ? sigLines.join('\n') : undefined,
  })
}

// Captura un bloque {} completo desde la línea de inicio
function captureBlock(lines: string[], start: number): string {
  let depth = 0
  let started = false
  const result: string[] = []

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? ''
    result.push(line)

    for (const ch of line) {
      if (ch === '{') { depth++; started = true }
      if (ch === '}') depth--
    }

    if (started && depth <= 0) break
    if (result.length > 50) break // Safety: no bloques enormes
  }

  return result.join('\n')
}

// Extrae la firma de una función (sin el cuerpo)
function extractSignature(lines: string[], start: number): string {
  let sig = ''
  for (let i = start; i < lines.length && i < start + 5; i++) {
    const line = lines[i] ?? ''
    sig += line.trim() + ' '
    if (line.includes('{') || line.includes('=>')) {
      // Corta antes del cuerpo
      sig = sig.replace(/\s*\{[^}]*$/, '').replace(/\s*=>\s*\{?[^}]*$/, '').trim()
      break
    }
  }
  return sig.trim()
}

// Genera el contenido del archivo .snap.md
export function buildSnapshotMd(
  section: string,
  artifacts: ExtractedArtifacts,
  updatedAt: string
): string {
  const parts = [
    `# snapshot: ${section}`,
    `> auto-generated — do not edit manually`,
    `> updated: ${updatedAt}`,
    '',
  ]

  if (artifacts.types) {
    parts.push('## types & interfaces', '```typescript', artifacts.types, '```', '')
  }
  if (artifacts.signatures) {
    parts.push('## exported functions', '```typescript', artifacts.signatures, '```', '')
  }
  if (artifacts.schema) {
    parts.push('## schema', '```sql', artifacts.schema, '```', '')
  }
  if (artifacts.env) {
    parts.push('## env variables', '```', artifacts.env, '```', '')
  }

  return parts.join('\n')
}
