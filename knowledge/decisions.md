# DECISIONS — claude-bridge

Registro de decisiones de arquitectura.
Antes de cambiar cualquiera de estas, lee el contexto completo.

---

## ADR-001: SQLite para metadata, filesystem para contenido

**Decisión:** SQLite guarda solo metadata (status, timestamps, sync_log).
Los archivos .md viven en el filesystem, en el repo del proyecto cliente.

**Porqué:**
- Los .md son versionables con git — la documentación evoluciona con el código
- Si el MCP server se cae, los archivos siguen siendo legibles directamente
- Sin vendor lock-in — son archivos de texto planos propiedad del usuario
- Claude Code puede leerlos directamente sin llamar al MCP si hace falta

**Alternativa descartada:** Guardar todo en SQLite.
Problema: no versionable, no legible sin el server, lock-in total.

---

## ADR-002: Bun como runtime, no Node.js

**Decisión:** Bun como runtime principal.

**Porqué:**
- Compatible con el stack que el usuario ya usa (PinTeach usa Bun)
- Más rápido en startup — importante para un server que se arranca con el dev env
- `bun run` ejecuta TypeScript directamente sin compilar en desarrollo
- `better-sqlite3` funciona perfectamente con Bun

**Nota:** Los scripts de git hooks usan `#!/bin/sh` puro para no depender de Bun
en el repo cliente (que podría tener otro runtime).

---

## ADR-003: Dos capas de conocimiento — narrativa y snapshot

**Decisión:** Cada sección tiene dos archivos: `{section}.md` y `{section}.snap.md`.

**Porqué:**
- La narrativa (el porqué, las decisiones) cambia lento y la escribe Claude
- El snapshot (código real, tipos) cambia rápido y lo genera una herramienta
- Mezclarlos produciría archivos que se sobreescriben mutuamente
- Claude.ai puede pedir solo narrativa o solo snapshot según lo que necesite
- Los snapshots nunca se editan manualmente — solo el extractor los toca

**Regla:** Si ves un humano editando un `.snap.md` a mano, algo está mal en el flujo.

---

## ADR-004: ctags como extractor principal, ast-grep como fallback

**Decisión:** ctags primero, ast-grep si ctags no está disponible.

**Porqué:**
- ctags soporta 200+ lenguajes sin configuración adicional
- Está disponible en prácticamente cualquier entorno de desarrollo
- Para TypeScript avanzado (generics complejos, conditional types), ast-grep
  da resultados más precisos pero requiere instalación adicional
- El 80% de los casos (interfaces, types, funciones exportadas) ctags los
  resuelve perfectamente

**Lo que NO extraemos:** Funciones internas, variables locales, imports, comentarios.
Solo la superficie pública que otro módulo (o Claude.ai) necesitaría conocer.

---

## ADR-005: Optimistic locking en save_context

**Decisión:** save_context acepta `last_read_at` y rechaza si hubo cambios.

**Porqué:**
- Claude.ai y Claude Code pueden escribir a la misma sección
- Last-write-wins borraría trabajo válido silenciosamente
- El conflicto explícito es mejor que la corrupción silenciosa
- En la práctica raro: Claude.ai diseña, Claude Code implementa — raramente
  tocan la misma sección al mismo tiempo

**Qué hace Claude cuando hay conflicto:**
Devuelve ambas versiones y propone un merge. Nunca elige sola.

---

## ADR-006: Sin auth en v1

**Decisión:** El server v1 no tiene autenticación.

**Porqué:**
- Es uso personal, local o behind tunnel
- Añadir auth complejiza el setup y el código sin valor real en v1
- El tunnel (ngrok/cloudflare) ya proporciona una capa de oscuridad

**Cuando añadir auth:** Cuando el server se comparta con un equipo o se
despliegue en infraestructura compartida. Implementar como `X-Bridge-Token`
header simple, no OAuth completo.

---

## ADR-007: Heartbeat en INDEX.md, no en base de datos

**Decisión:** El campo `last_sync` se escribe directamente en INDEX.md,
no solo en SQLite.

**Porqué:**
- Claude Code puede leer INDEX.md sin llamar al MCP server
- Si el MCP cae, Claude Code aún puede ver cuándo fue el último sync
- Hace el estado del watcher visible en el propio archivo que Claude lee
- Es la implementación más simple que cubre el caso de uso

---

## ADR-008: Namespace por proyecto en todas las keys

**Decisión:** Todas las operaciones incluyen `project` como identificador.
Las keys de SQLite son `(project_id, section_id)`.

**Porqué:**
- Un solo MCP server puede servir múltiples proyectos
- Sin namespace, `database` en PinTeach y `database` en otro proyecto
  serían indistinguibles
- El `.claude-bridge` define el project name y actúa como namespace token

**Formato de project_id:** lowercase, sin espacios, sin caracteres especiales.
Ejemplo: `pinteach`, `saastro`, `my-project`.
