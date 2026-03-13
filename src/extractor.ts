// Extrae tipos, interfaces y firmas de archivos de código
// Principal: ctags | Fallback: ast-grep

import { execa } from 'execa'
import { readFileSync, existsSync } from 'fs'
import type { Result } from './types.ts'
import { ok, err } from './types.ts'

export interface ExtractedArtifacts {
  types?: string
  signatures?: string
  schema?: string
  env?: string
}

// Detecta si ctags está disponible
let ctagsAvailable: boolean | undefined
async function hasCTags(): Promise<boolean> {
  if (ctagsAvailable !== undefined) return ctagsAvailable
  try {
    await execa('ctags', ['--version'])
    ctagsAvailable = true
  } catch {
    ctagsAvailable = false
  }
  return ctagsAvailable
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
        return `-- ${f}\n${readFileSync(f, 'utf-8')}`
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

async function extractTypeScript(
  files: string[]
): Promise<Result<Pick<ExtractedArtifacts, 'types' | 'signatures'>>> {
  if (await hasCTags()) {
    return extractWithCTags(files)
  }
  return extractWithAstGrep(files)
}

async function extractWithCTags(
  files: string[]
): Promise<Result<Pick<ExtractedArtifacts, 'types' | 'signatures'>>> {
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

    // Interfaces y types
    const typeEntries = tags
      .filter((t: any) => ['interface', 'type', 'enum', 'class'].includes(t.kind))
      .map((t: any) => `// ${t.path}:${t.line}\n${t.kind} ${t.name}`)

    // Funciones y métodos exportados
    const funcEntries = tags
      .filter((t: any) => ['function', 'method'].includes(t.kind) && t.access === 'public')
      .map((t: any) => `// ${t.path}:${t.line}\nexport function ${t.name}(...)`)

    return ok({
      types: typeEntries.length > 0 ? typeEntries.join('\n\n') : undefined,
      signatures: funcEntries.length > 0 ? funcEntries.join('\n') : undefined,
    })
  } catch (e) {
    return err(`ctags failed: ${e}`)
  }
}

async function extractWithAstGrep(
  files: string[]
): Promise<Result<Pick<ExtractedArtifacts, 'types' | 'signatures'>>> {
  try {
    // Extrae interfaces y types exportados
    const { stdout: typeOutput } = await execa('sg', [
      'run',
      '--pattern', 'export $KIND $NAME { $$$BODY }',
      '--json',
      ...files,
    ])

    // Extrae funciones exportadas
    const { stdout: funcOutput } = await execa('sg', [
      'run',
      '--pattern', 'export function $NAME($$$PARAMS): $RET { $$$BODY }',
      '--json',
      ...files,
    ])

    const parseAstGrepOutput = (raw: string): string[] => {
      try {
        const results = JSON.parse(raw)
        return results.map((r: any) => r.text ?? '').filter(Boolean)
      } catch { return [] }
    }

    return ok({
      types: parseAstGrepOutput(typeOutput).join('\n\n') || undefined,
      signatures: parseAstGrepOutput(funcOutput).join('\n') || undefined,
    })
  } catch (e) {
    return err(`ast-grep failed: ${e}`)
  }
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
