// packages/canon_application/src/use_cases/resolve_conflict.ts
// Caso de uso: resolucion humana determinista de conflictos en Canon.
// Emite evento inmutable RESOLVE_CONFLICT que entierra las versiones en disputa.
// Soporte de AbortSignal (Seccion 5.4).

import { randomUUID } from 'node:crypto';
import type { EventStore, ResolveConflictEvent, Projection, PolicyConfig } from '../../../canon_domain/src/index.ts';
import { fold, DEFAULT_POLICY_CONFIG } from '../../../canon_domain/src/index.ts';

export interface ResolveConflictRequest {
  entity_key: string;
  resolves_event_ids: string[];
  winning_value: string;
  authority: number;
  source_session_id?: string;
  signal?: AbortSignal;
}

export interface ResolveConflictResult {
  ok: boolean;
  event_id: string;
  projection: Projection;
}

export class ResolveConflictUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(store: EventStore, policy: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: ResolveConflictRequest): Promise<ResolveConflictResult> {
    if (request.signal?.aborted) {
      throw new Error('Operación cancelada por AbortSignal');
    }

    const eventId = `res_${randomUUID()}`;
    const event: ResolveConflictEvent = {
      id: eventId,
      entity_key: request.entity_key,
      logical_ts: 0,
      resolves_event_ids: request.resolves_event_ids,
      winning_value: request.winning_value,
      authority: request.authority,
      source_session_id: request.source_session_id,
      created_at: new Date().toISOString(),
      type: 'RESOLVE_CONFLICT',
    };

    await this.store.append(event, request.signal);

    const allEvents = await this.store.getAllEvents(request.signal);
    const projection = fold(allEvents, this.policy);

    return {
      ok: true,
      event_id: eventId,
      projection,
    };
  }
}
