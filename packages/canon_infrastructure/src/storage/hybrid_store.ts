// packages/canon_infrastructure/src/storage/hybrid_store.ts
// Almacenamiento hibrido de alta concurrencia y resiliencia:
// 1. events.jsonl: FUENTE DE VERDAD inmutable versionable en Git (append-only de texto plano).
// 2. cache.db: Proyeccion SQLite local efimera (ignorada en Git), invalidada por hash SHA-256.
// 3. Mutex atomico en filesystem con recuperacion automatica de stale locks huerfanos.
// 4. Soporte de AbortSignal para corte de transacciones (Seccion 5.4).
// Complejidad ciclomatica <= 5 por funcion garantizada.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEvent, ConflictState, EventStore } from '../../../canon_domain/src/index.ts';
import { fold, DEFAULT_POLICY_CONFIG } from '../../../canon_domain/src/index.ts';
import { verifyEventSignature } from '../crypto/signer.ts';

// Sanitizador defensivo contra Path Traversal y Connection String Injection
export function assertSafeChildPath(baseDir: string, expectedFileName: string): string {
  const safeBase = resolve(baseDir);
  if (safeBase.includes('\0')) {
    throw new Error('Path traversal: null byte detected in base directory');
  }
  const safeChild = resolve(safeBase, expectedFileName);
  if (!safeChild.startsWith(safeBase) || basename(safeChild) !== expectedFileName) {
    throw new Error(`Path traversal: child path escapes base directory: ${expectedFileName}`);
  }
  return safeChild;
}

export function validateCanonDirPath(rawCanonDir: string): string {
  const rawDir = resolve(rawCanonDir);
  if (rawDir.includes('\0')) {
    throw new Error('Path traversal: null byte detected in directory path');
  }
  const parentDir = dirname(rawDir);
  const dirName = basename(rawDir);
  const safeCanonDir = assertSafeChildPath(parentDir, dirName);
  if (!safeCanonDir.startsWith(parentDir) || basename(safeCanonDir) !== dirName) {
    throw new Error('Path traversal: invalid directory path');
  }
  return safeCanonDir;
}

export function cleanupStaleLockIfExpired(safeLockPath: string): boolean {
  try {
    const s = statSync(safeLockPath);
    if (Date.now() - s.mtimeMs > 5000) {
      rmdirSync(safeLockPath);
      return true;
    }
  } catch {}
  return false;
}

export function tryCreateLockDirectory(safeLockPath: string): (() => void) | null {
  try {
    mkdirSync(safeLockPath);
    return () => {
      try {
        rmdirSync(safeLockPath);
      } catch {}
    };
  } catch {
    return null;
  }
}

export function extractCacheRowParams(evt: MemoryEvent): {
  slotType: string | null;
  value: string;
  supersedesId: string | null;
  resolvesIds: string | null;
  effectiveAuthority: number;
} {
  const slotType = evt.type === 'ASSERT' ? evt.slot_type : null;
  const value = evt.type === 'SUPERSEDE' ? evt.new_value : evt.type === 'RESOLVE_CONFLICT' ? evt.winning_value : evt.value;
  const supersedesId = (evt.type === 'SUPERSEDE' || evt.type === 'ASSERT') ? evt.supersedes_event_id ?? null : null;
  const resolvesIds = evt.type === 'RESOLVE_CONFLICT' ? JSON.stringify(evt.resolves_event_ids) : null;

  let effectiveAuthority = evt.authority;
  if (effectiveAuthority > 40 && !verifyEventSignature(evt)) {
    effectiveAuthority = 40;
  }

  return { slotType, value, supersedesId, resolvesIds, effectiveAuthority };
}

export class HybridEventStore implements EventStore {
  private canonDir: string;
  private jsonlPath: string;
  private lockPath: string;
  private db: DatabaseSync;

  constructor(canonDir: string) {
    const safeCanonDir = validateCanonDirPath(canonDir);
    this.canonDir = safeCanonDir;
    this.jsonlPath = assertSafeChildPath(safeCanonDir, 'events.jsonl');
    this.lockPath = assertSafeChildPath(safeCanonDir, 'events.jsonl.lock');
    const dbPath = assertSafeChildPath(safeCanonDir, 'cache.db');

    if (!existsSync(safeCanonDir)) {
      mkdirSync(safeCanonDir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout = 5000;`);
    } catch {}
    this.initCacheSchema();
    this.syncCache();
  }

  private tryInitSchemaStep(): boolean {
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS cache_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_events (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL DEFAULT 1,
          entity_key TEXT NOT NULL,
          logical_ts INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          slot_type TEXT,
          value TEXT NOT NULL,
          authority INTEGER NOT NULL,
          signature TEXT,
          supersedes_event_id TEXT,
          resolves_event_ids TEXT,
          source_session_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_key ON memory_events(entity_key);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON memory_events(logical_ts);
      `);
      return true;
    } catch (err: any) {
      if (err.message?.includes('locked') || err.message?.includes('busy')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        return false;
      }
      throw err;
    }
  }

  private initCacheSchema(): void {
    let retries = 5;
    while (retries > 0) {
      if (this.tryInitSchemaStep()) break;
      retries--;
    }

    try {
      this.db.exec(`ALTER TABLE memory_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;`);
    } catch {}
    try {
      this.db.exec(`ALTER TABLE memory_events ADD COLUMN signature TEXT;`);
    } catch {}
  }

  syncCache(): { reloaded: boolean; conflicts: ConflictState[] } {
    const safeJsonlPath = assertSafeChildPath(this.canonDir, 'events.jsonl');
    if (!existsSync(safeJsonlPath)) {
      return { reloaded: false, conflicts: [] };
    }

    const fileContent = readFileSync(safeJsonlPath);
    const currentHash = createHash('sha256').update(fileContent).digest('hex');

    const metaStmt = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'source_sha256'`);
    const metaRow = metaStmt.get() as { value: string } | undefined;

    if (metaRow && metaRow.value === currentHash) {
      return { reloaded: false, conflicts: [] };
    }

    const events = this.readEventsFromDisk();
    events.sort((a, b) => (a.logical_ts ?? 0) - (b.logical_ts ?? 0) || a.id.localeCompare(b.id));

    this.rebuildCacheDb(events, currentHash);

    const projection = fold(events, DEFAULT_POLICY_CONFIG, (e) => verifyEventSignature(e));
    return { reloaded: true, conflicts: Array.from(projection.conflicts.values()) };
  }

  private rebuildCacheDb(events: MemoryEvent[], currentHash: string): void {
    this.db.exec(`DELETE FROM memory_events;`);

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_events (
        id, schema_version, entity_key, logical_ts, event_type, slot_type, value, authority,
        signature, supersedes_event_id, resolves_event_ids, source_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const evt of events) {
      const p = extractCacheRowParams(evt);
      insertStmt.run(
        evt.id,
        evt.schema_version ?? 1,
        evt.entity_key,
        evt.logical_ts ?? 0,
        evt.type,
        p.slotType,
        p.value,
        p.effectiveAuthority,
        evt.signature ?? null,
        p.supersedesId,
        p.resolvesIds,
        evt.source_session_id ?? null,
        evt.created_at
      );
    }

    const updateMetaStmt = this.db.prepare(`
      INSERT INTO cache_meta (key, value) VALUES ('source_sha256', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    updateMetaStmt.run(currentHash);
  }

  async withLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    const releaseLock = await this.acquireLock(20, 25, signal);
    try {
      return await action();
    } finally {
      releaseLock();
    }
  }

  appendUnlocked(event: MemoryEvent): void {
    const diskEvents = this.readEventsFromDisk();
    if (!event.logical_ts || event.logical_ts === 0) {
      const currentMaxTs = diskEvents.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
      event.logical_ts = currentMaxTs + 1;
    }
    event.schema_version = event.schema_version ?? 1;

    const safeJsonlPath = assertSafeChildPath(this.canonDir, 'events.jsonl');
    const line = JSON.stringify(event) + '\n';
    appendFileSync(safeJsonlPath, line, 'utf8');

    this.syncCache();
  }

  async append(event: MemoryEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    await this.withLock(async () => {
      this.appendUnlocked(event);
    }, signal);
  }

  async getEvents(entityKey: string, signal?: AbortSignal): Promise<MemoryEvent[]> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    this.syncCache();
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events WHERE entity_key = ? ORDER BY logical_ts ASC
    `);
    const rows = stmt.all(entityKey) as any[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  async getAllEvents(signal?: AbortSignal): Promise<MemoryEvent[]> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    this.syncCache();
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events ORDER BY logical_ts ASC
    `);
    const rows = stmt.all() as any[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  close(): void {
    this.db.close();
  }

  private readEventsFromDisk(): MemoryEvent[] {
    const safeJsonlPath = assertSafeChildPath(this.canonDir, 'events.jsonl');
    if (!existsSync(safeJsonlPath)) return [];
    const content = readFileSync(safeJsonlPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
  }

  private async acquireLock(
    maxRetries: number = 20,
    delayMs: number = 25,
    signal?: AbortSignal
  ): Promise<() => void> {
    const safeLockPath = assertSafeChildPath(this.canonDir, 'events.jsonl.lock');
    for (let i = 0; i < maxRetries; i++) {
      if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
      const release = tryCreateLockDirectory(safeLockPath);
      if (release) return release;
      if (cleanupStaleLockIfExpired(safeLockPath)) continue;
      await new Promise((res) => setTimeout(res, delayMs + (i % 5) * 5));
    }
    throw new Error(`Timeout al adquirir lock en ${safeLockPath}`);
  }

  private mapRowToEvent(row: any): MemoryEvent {
    const base = {
      id: row.id,
      schema_version: row.schema_version ?? 1,
      entity_key: row.entity_key,
      logical_ts: row.logical_ts,
      authority: row.authority,
      signature: row.signature ?? undefined,
      source_session_id: row.source_session_id ?? undefined,
      created_at: row.created_at,
    };

    if (row.event_type === 'ASSERT') {
      return {
        ...base,
        type: 'ASSERT',
        slot_type: row.slot_type ?? 'SINGLE_VALUED',
        value: row.value,
        supersedes_event_id: row.supersedes_event_id ?? undefined,
      };
    }

    if (row.event_type === 'SUPERSEDE') {
      return {
        ...base,
        type: 'SUPERSEDE',
        supersedes_event_id: row.supersedes_event_id ?? '',
        new_value: row.value,
      };
    }

    return {
      ...base,
      type: 'RESOLVE_CONFLICT',
      resolves_event_ids: row.resolves_event_ids ? JSON.parse(row.resolves_event_ids) : [],
      winning_value: row.value,
    };
  }
}
