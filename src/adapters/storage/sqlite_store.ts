// src/adapters/storage/sqlite_store.ts
// Adaptador SQLite usando el modulo nativo 'node:sqlite' de Node 24.
// Cero gyp, cero compilaciones en Windows, cero librerias pesadas de NPM.
// Todas las consultas son 100% parametrizadas (inyeccion SQL imposible).

import { DatabaseSync } from 'node:sqlite';
import type { MemoryEvent, AssertEvent, SupersedeEvent, ResolveConflictEvent } from '../../domain/models.ts';
import type { EventStore } from '../../ports/event_store.ts';

interface EventRow {
  id: string;
  entity_key: string;
  event_type: 'ASSERT' | 'SUPERSEDE' | 'RESOLVE_CONFLICT';
  slot_type: 'SINGLE_VALUED' | 'ACCUMULATIVE' | null;
  value: string;
  authority: number;
  supersedes_event_id: string | null;
  resolves_event_ids: string | null;
  source_session_id: string | null;
  created_at: string;
}

export class SQLiteEventStore implements EventStore {
  private db: DatabaseSync;

  constructor(dbPath: string = 'canon.db') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    // WAL mode para lecturas y escrituras concurrentes sin locks molestos
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        entity_key TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_events_created ON memory_events(created_at);
    `);
  }

  async append(event: MemoryEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO memory_events (
        id, entity_key, event_type, slot_type, value, authority,
        supersedes_event_id, resolves_event_ids, source_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const slotType = event.type === 'ASSERT' ? event.slot_type : null;
    const value = event.type === 'SUPERSEDE' ? event.new_value : event.type === 'RESOLVE_CONFLICT' ? event.winning_value : event.value;
    const supersedesId = event.type === 'SUPERSEDE' ? event.supersedes_event_id : null;
    const resolvesIds = event.type === 'RESOLVE_CONFLICT' ? JSON.stringify(event.resolves_event_ids) : null;

    stmt.run(
      event.id,
      event.entity_key,
      event.type,
      slotType,
      value,
      event.authority,
      supersedesId,
      resolvesIds,
      event.source_session_id ?? null,
      event.created_at
    );
  }

  async getEvents(entityKey: string): Promise<MemoryEvent[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events 
      WHERE entity_key = ? 
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(entityKey) as unknown as EventRow[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  async getAllEvents(): Promise<MemoryEvent[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_events 
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as unknown as EventRow[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  close(): void {
    this.db.close();
  }

  private mapRowToEvent(row: EventRow): MemoryEvent {
    const base = {
      id: row.id,
      entity_key: row.entity_key,
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
      } as AssertEvent;
    }

    if (row.event_type === 'SUPERSEDE') {
      return {
        ...base,
        type: 'SUPERSEDE',
        supersedes_event_id: row.supersedes_event_id ?? '',
        new_value: row.value,
      } as SupersedeEvent;
    }

    const resolvesIds: string[] = row.resolves_event_ids ? JSON.parse(row.resolves_event_ids) : [];
    return {
      ...base,
      type: 'RESOLVE_CONFLICT',
      resolves_event_ids: resolvesIds,
      winning_value: row.value,
    } as ResolveConflictEvent;
  }
}
