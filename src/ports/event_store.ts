// src/ports/event_store.ts
// Puerto hexagonal: define como el sistema almacena y lee eventos.
// No le importa si atras hay SQLite, Postgres, Redis o memoria RAM.

import type { MemoryEvent } from '../domain/models.ts';

export interface EventStore {
  append(event: MemoryEvent): Promise<void>;
  getEvents(entityKey: string): Promise<MemoryEvent[]>;
  getAllEvents(): Promise<MemoryEvent[]>;
  withLock?<T>(action: () => Promise<T>): Promise<T>;
  appendUnlocked?(event: MemoryEvent): void;
}
