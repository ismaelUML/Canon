// src/domain/models.ts
// Dominio puro de Canon: cero I/O, cero librerias externas, cero estado global.
// Si algo aca llega a importar 'node:fs' o 'node:sqlite', rompe la arquitectura.

export type SlotCardinality = 'SINGLE_VALUED' | 'ACCUMULATIVE';

export const Authority = {
  USER_EXPLICIT: 100,  // El usuario lo dijo clarito con sus propias palabras
  REPO_ORACLE: 90,     // Leido directamente de package.json, configs o el compilador
  CODE_VERIFIED: 80,   // Salio de un test pasando o un diff exitoso
  INFERRED: 40,        // Deducido al vuelo de una charla informal
} as const;

export type AuthorityLevel = number;

export interface BaseEvent {
  id: string;
  entity_key: string;
  authority: AuthorityLevel;
  source_session_id?: string;
  created_at: string;
}

export interface AssertEvent extends BaseEvent {
  type: 'ASSERT';
  slot_type: SlotCardinality;
  value: string;
}

export interface SupersedeEvent extends BaseEvent {
  type: 'SUPERSEDE';
  supersedes_event_id: string;
  new_value: string;
}

export interface ResolveConflictEvent extends BaseEvent {
  type: 'RESOLVE_CONFLICT';
  resolves_event_ids: string[];
  winning_value: string;
}

export type MemoryEvent = AssertEvent | SupersedeEvent | ResolveConflictEvent;

export interface ActiveFact {
  id: string;
  entity_key: string;
  slot_type: SlotCardinality;
  value: string;
  authority: AuthorityLevel;
  source_event_id: string;
  updated_at: string;
}

export interface ConflictState {
  entity_key: string;
  conflicting_events: MemoryEvent[];
  reason: string;
  detected_at: string;
}

export interface Projection {
  // En SINGLE_VALUED hay un solo ActiveFact. En ACCUMULATIVE hay un array.
  active_facts: Map<string, ActiveFact[]>;
  conflicts: Map<string, ConflictState>;
  superseded_event_ids: Set<string>;
}
