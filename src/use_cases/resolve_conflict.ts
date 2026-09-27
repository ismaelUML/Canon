// src/use_cases/resolve_conflict.ts
// Caso de uso: resuelve explicitamente un conflicto entre dos aserciones del mismo nivel.
// Emite el evento inmutable RESOLVE_CONFLICT que entierra las versiones en disputa.

import type { EventStore } from '../ports/event_store.ts';
import type { ResolveConflictEvent, Projection } from '../domain/models.ts';
import { fold } from '../domain/fold.ts';
import type { PolicyConfig } from '../domain/policy.ts';
import { DEFAULT_POLICY_CONFIG } from '../domain/policy.ts';

export interface ResolveConflictRequest {
  entity_key: string;
  resolves_event_ids: string[];
  winning_value: string;
  authority: number;
  source_session_id?: string;
}

export interface ResolveConflictResult {
  ok: boolean;
  event_id: string;
  projection: Projection;
}

export class ResolveConflictUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(
    store: EventStore,
    policy: PolicyConfig = DEFAULT_POLICY_CONFIG
  ) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: ResolveConflictRequest): Promise<ResolveConflictResult> {
    const eventId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const event: ResolveConflictEvent = {
      id: eventId,
      entity_key: request.entity_key,
      resolves_event_ids: request.resolves_event_ids,
      winning_value: request.winning_value,
      authority: request.authority,
      source_session_id: request.source_session_id,
      created_at: new Date().toISOString(),
      type: 'RESOLVE_CONFLICT',
    };

    await this.store.append(event);

    const allEvents = await this.store.getAllEvents();
    const projection = fold(allEvents, this.policy);

    return {
      ok: true,
      event_id: eventId,
      projection,
    };
  }
}
