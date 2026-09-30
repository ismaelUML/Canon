// packages/canon_domain/src/ports/event_store.ts
// Puerto hexagonal: define como el sistema almacena y lee eventos.
// Soporta cancelacion reactiva profunda mediante AbortSignal (Seccion 5.4).

import type { MemoryEvent } from '../models.ts';

export interface EventStore {
  append(event: MemoryEvent, signal?: AbortSignal): Promise<void>;
  getEvents(entityKey: string, signal?: AbortSignal): Promise<MemoryEvent[]>;
  getAllEvents(signal?: AbortSignal): Promise<MemoryEvent[]>;
  withLock?<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  appendUnlocked?(event: MemoryEvent): void;
}
