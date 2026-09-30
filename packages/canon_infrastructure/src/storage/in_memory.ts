// packages/canon_infrastructure/src/storage/in_memory.ts
// Adaptador en memoria para tests y fallback degradado.
// Complejidad ciclomatica <= 5 por funcion garantizada.

import type { MemoryEvent, EventStore } from '../../../canon_domain/src/index.ts';

export class InMemoryEventStore implements EventStore {
  private events: MemoryEvent[] = [];

  async append(event: MemoryEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    this.appendUnlocked(event);
  }

  appendUnlocked(event: MemoryEvent): void {
    if (!event.logical_ts || event.logical_ts === 0) {
      const currentMaxTs = this.events.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
      event.logical_ts = currentMaxTs + 1;
    }
    this.events.push(event);
  }

  async withLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    return await action();
  }

  async getEvents(entityKey: string, signal?: AbortSignal): Promise<MemoryEvent[]> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    return this.events.filter((e) => e.entity_key === entityKey);
  }

  async getAllEvents(signal?: AbortSignal): Promise<MemoryEvent[]> {
    if (signal?.aborted) throw new Error('Operación cancelada por AbortSignal');
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
