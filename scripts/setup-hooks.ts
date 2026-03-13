#!/usr/bin/env bun
// Instala los git hooks en el repo cliente
// Uso: bun run --cwd /path/to/claude-bridge scripts/setup-hooks.ts /path/to/client-repo

import { join, dirname } from 'path'
import { copyFileSync, mkdirSync, chmodSync, existsSync } from 'fs'

const clientRepo = process.argv[2] ?? process.cwd()
const hooksDir = join(clientRepo, '.husky')
const gitHooksDir = join(clientRepo, '.git', 'hooks')

if (!existsSync(join(clientRepo, '.git'))) {
  console.error(`❌ Not a git repository: ${clientRepo}`)
  process.exit(1)
}

// Copia el hook
mkdirSync(gitHooksDir, { recursive: true })

const hookSrc = join(import.meta.dir, 'post-commit.sh')
const hookDst = join(gitHooksDir, 'post-commit')

copyFileSync(hookSrc, hookDst)
chmodSync(hookDst, 0o755)

console.log(`✅ Git hook installed: ${hookDst}`)
console.log(`\nTo test it, make a commit in ${clientRepo}`)
