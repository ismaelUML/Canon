// src/adapters/storage/in_memory.ts
// Adaptador en memoria para tests. Cero dependencias de base de datos,
// cero filesystem, ideal para correr benchmarks de regresion en CI en microsegundos.

import type { MemoryEvent } from '../../domain/models.ts';
import type { EventStore } from '../../ports/event_store.ts';

export class InMemoryEventStore implements EventStore {
  private events: MemoryEvent[] = [];

  async append(event: MemoryEvent): Promise<void> {
    this.events.push(event);
  }

  async getEvents(entityKey: string): Promise<MemoryEvent[]> {
    return this.events.filter((e) => e.entity_key === entityKey);
  }

  async getAllEvents(): Promise<MemoryEvent[]> {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
