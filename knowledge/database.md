# database

SQLite para metadata, filesystem/R2 para contenido (ADR-001).

## Dos implementaciones, mismo schema

### Local: bun:sqlite (src/storage.ts)
- Database singleton con lazy init
- Funciones sync: getProject(), listSections(), upsertSection(), etc.
- PRAGMA WAL + foreign keys ON
- DB path: data/bridge.db

### Workers: D1 (src/storage-d1.ts)
- Funciones async que reciben D1Database como primer param
- Misma API: getProject(db, id), listSections(db, projectId)
- Migración en migrations/0001_initial.sql
- Incluye tablas OAuth (oauth_clients, oauth_codes, oauth_tokens)

## Schema

3 tablas core + 3 tablas OAuth:

- **projects** (id PK, path, created_at, last_sync)
- **sections** (id + project_id PK compuesta, status, summary, last_updated, last_read_at)
- **sync_log** (autoincrement, project_id, section_id, action, source, created_at)

Row types usan snake_case (SQLite). Mappers toProject()/toSection() convierten a camelCase.
Positional params (?) en ambos — bun:sqlite no soporta named params (@).

## Decisiones

- Nunca duplicar contenido .md en la DB (ADR-001)
- Optimistic locking via last_read_at en save_context (ADR-005)
- Namespace por project_id en todas las keys (ADR-008)
- La migración local usa db.exec() separados (Bun bug con multi-statement + foreign keys)
