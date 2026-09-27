// src/adapters/storage/hybrid_store.ts
// Almacenamiento hibrido de alta concurrencia:
// 1. events.jsonl: FUENTE DE VERDAD inmutable versionable en Git (append-only de texto plano).
// 2. cache.db: Proyeccion SQLite local efimera (ignorada en Git), invalidada por hash SHA-256.
// 3. Mutex atomico a nivel de filesystem: bloquea escrituras concurrentes entre ventanas de Antigravity
//    y re-lee siempre el reloj logico de disco antes de asignar logical_ts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEvent, ConflictState } from '../../domain/models.ts';
import type { EventStore } from '../../ports/event_store.ts';
import { fold } from '../../domain/fold.ts';

export class HybridEventStore implements EventStore {
  private canonDir: string;
  private jsonlPath: string;
  private lockPath: string;
  private db: DatabaseSync;

  constructor(canonDir: string) {
    this.canonDir = canonDir;
    this.jsonlPath = join(canonDir, 'events.jsonl');
    this.lockPath = join(canonDir, 'events.jsonl.lock');
    const dbPath = join(canonDir, 'cache.db');

    if (!existsSync(canonDir)) {
      mkdirSync(canonDir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initCacheSchema();
    this.syncCache();
  }

  private initCacheSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        entity_key TEXT NOT NULL,
        logical_ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        slot_type TEXT,
        value TEXT NOT NULL,
        authority INTEGER NOT NULL,
        supersedes_event_id TEXT,
        resolves_event_ids TEXT,
        source_session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_key ON memory_events(entity_key);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON memory_events(logical_ts);
    `);
  }

  // Sincroniza la cache SQLite con el JSONL validando el hash SHA-256 del archivo
  syncCache(): { reloaded: boolean; conflicts: ConflictState[] } {
    if (!existsSync(this.jsonlPath)) {
      return { reloaded: false, conflicts: [] };
    }

    const fileContent = readFileSync(this.jsonlPath);
    const currentHash = createHash('sha256').update(fileContent).digest('hex');

    const metaStmt = this.db.prepare(`SELECT value FROM cache_meta WHERE key = 'source_sha256'`);
    const metaRow = metaStmt.get() as { value: string } | undefined;

    if (metaRow && metaRow.value === currentHash) {
      return { reloaded: false, conflicts: [] };
    }

    // Reconstruir cache: leemos JSONL, ordenamos por causalidad logica y reinsertamos
    const events = this.readEventsFromDisk();
    events.sort((a, b) => (a.logical_ts ?? 0) - (b.logical_ts ?? 0) || a.id.localeCompare(b.id));

    this.db.exec(`DELETE FROM memory_events;`);

    const insertStmt = this.db.prepare(`
      INSERT INTO memory_events (
        id, entity_key, logical_ts, event_type, slot_type, value, authority,
        supersedes_event_id, resolves_event_ids, source_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const evt of events) {
      const slotType = evt.type === 'ASSERT' ? evt.slot_type : null;
      const value = evt.type === 'SUPERSEDE' ? evt.new_value : evt.type === 'RESOLVE_CONFLICT' ? evt.winning_value : evt.value;
      const supersedesId = evt.type === 'SUPERSEDE' ? evt.supersedes_event_id : null;
      const resolvesIds = evt.type === 'RESOLVE_CONFLICT' ? JSON.stringify(evt.resolves_event_ids) : null;

      insertStmt.run(
        evt.id,
        evt.entity_key,
        evt.logical_ts ?? 0,
        evt.type,
        slotType,
        value,
        evt.authority,
        supersedesId,
        resolvesIds,
        evt.source_session_id ?? null,
        evt.created_at
      );
    }

    const updateMetaStmt = this.db.prepare(`
      INSERT INTO cache_meta (key, value) VALUES ('source_sha256', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    updateMetaStmt.run(currentHash);

    // Escaneo proactivo post-rebuild para atrapar contradicciones de merge de inmediato
    const projection = fold(events);
    const conflicts = Array.from(projection.conflicts.values());

    return { reloaded: true, conflicts };
  }

  async append(event: MemoryEvent): Promise<void> {
    const releaseLock = await this.acquireLock();
    try {
      // Re-leemos el disco bajo lock para obtener el reloj logico exacto y evitar colisiones
      const diskEvents = this.readEventsFromDisk();
      const currentMaxTs = diskEvents.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
      event.logical_ts = currentMaxTs + 1;

      // Escribir en texto plano en events.jsonl
      const line = JSON.stringify(event) + '\n';
      appendFileSync(this.jsonlPath, line, 'utf8');

      // Actualizar cache local
      this.syncCache();
    } finally {
      releaseLock();
    }
  }

  async getEvents(entityKey: string): Promise<MemoryEvent[]> {
    this.syncCache();
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events WHERE entity_key = ? ORDER BY logical_ts ASC
    `);
    const rows = stmt.all(entityKey) as any[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  async getAllEvents(): Promise<MemoryEvent[]> {
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
    if (!existsSync(this.jsonlPath)) return [];
    const content = readFileSync(this.jsonlPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
  }

  private async acquireLock(maxRetries: number = 20, delayMs: number = 25): Promise<() => void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        mkdirSync(this.lockPath); // Operacion atomica en el filesystem
        return () => {
          try {
            rmdirSync(this.lockPath);
          } catch {
            // Ignorado si ya se libero
          }
        };
      } catch (err: any) {
        // Chequeo de lock colgado/huerfano (mas de 5 segundos de antiguedad)
        try {
          const s = statSync(this.lockPath);
          if (Date.now() - s.mtimeMs > 5000) {
            rmdirSync(this.lockPath);
            continue;
          }
        } catch {
          // Ignorado si se borro entremedio
        }
        await new Promise((res) => setTimeout(res, delayMs + (i % 5) * 5));
      }
    }
    throw new Error(`Timeout al adquirir lock en ${this.lockPath}`);
  }

  private mapRowToEvent(row: any): MemoryEvent {
    const base = {
      id: row.id,
      entity_key: row.entity_key,
      logical_ts: row.logical_ts,
      authority: row.authority,
      source_session_id: row.source_session_id ?? undefined,
      created_at: row.created_at,
    };

    if (row.event_type === 'ASSERT') {
      return {
        ...base,
        type: 'ASSERT',
        slot_type: row.slot_type ?? 'SINGLE_VALUED',
        value: row.value,
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
