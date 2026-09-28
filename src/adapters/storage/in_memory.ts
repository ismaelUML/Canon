// src/adapters/storage/in_memory.ts
// Adaptador en memoria para tests. Cero dependencias de base de datos,
// cero filesystem, ideal para correr benchmarks de regresion en CI en microsegundos.

import type { MemoryEvent } from '../../domain/models.ts';
import type { EventStore } from '../../ports/event_store.ts';

export class InMemoryEventStore implements EventStore {
  private events: MemoryEvent[] = [];

  async append(event: MemoryEvent): Promise<void> {
    this.appendUnlocked(event);
  }

  appendUnlocked(event: MemoryEvent): void {
    if (!event.logical_ts || event.logical_ts === 0) {
      const currentMaxTs = this.events.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
      event.logical_ts = currentMaxTs + 1;
    }
    this.events.push(event);
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    return await action();
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
