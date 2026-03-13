# claude-bridge

MCP server que actúa como puente de contexto compartido entre Claude.ai y Claude Code.
Permite que ambas interfaces lean y escriban contexto de proyecto en tiempo real.

## Stack
- Runtime: Bun
- Language: TypeScript
- MCP SDK: @modelcontextprotocol/sdk
- Storage: SQLite (better-sqlite3)
- Linter: Biome (single quotes, 2-space indent)
- File watching: chokidar
- Code parsing: execa + ctags/tree-sitter

## Estructura del proyecto
```
claude-bridge/
├── CLAUDE.md
├── package.json
├── biome.json
├── tsconfig.json
├── src/
│   ├── index.ts           ← entry point, arranca el MCP server
│   ├── server.ts          ← definición de tools MCP
│   ├── storage.ts         ← SQLite layer
│   ├── watcher.ts         ← Chokidar file watcher
│   ├── extractor.ts       ← tree-sitter / ctags snapshot extractor
│   ├── health.ts          ← heartbeat + /health endpoint
│   └── types.ts           ← tipos compartidos
├── scripts/
│   ├── bootstrap.ts       ← genera KB inicial para proyecto existente
│   ├── post-commit.sh     ← git hook para snapshot automático
│   └── cleanup.ts         ← auto-cleanup semanal
└── .claude-bridge         ← config del proyecto (copiable a cualquier repo)
```

## Convenciones
- Imports con single quotes
- 2-space indent
- No semicolons
- Types explícitos, no any
- Async/await siempre, no .then()
- Errores con Result<T, E> pattern, no throw

## Comandos
```bash
bun run dev      # servidor en modo desarrollo con hot reload
bun run build    # compila a dist/
bun run start    # arranca desde dist/
bun run check    # biome lint + format
```

## Contexto del proyecto
Lee /docs/SPEC.md antes de implementar cualquier cosa.
Ante cualquier duda de diseño, consulta /docs/DECISIONS.md.
