// src/use_cases/query_active_state.ts
// Caso de uso: consulta la verdad actual para inyectar al contexto del agente.
// Solo devuelve hechos que sobrevivieron al fold (cero hechos muertos)
// y destaca si hay algun conflicto sin resolver.

import type { EventStore } from '../ports/event_store.ts';
import type { ActiveFact, ConflictState } from '../domain/models.ts';
import { fold } from '../domain/fold.ts';
import type { PolicyConfig } from '../domain/policy.ts';
import { DEFAULT_POLICY_CONFIG } from '../domain/policy.ts';

export interface QueryActiveStateRequest {
  anchor?: string; // Ej: 'db:', 'dep:tailwindcss', 'security:'
}

export interface QueryActiveStateResponse {
  facts: ActiveFact[];
  conflicts: ConflictState[];
  formattedContext: string;
}

export class QueryActiveStateUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(
    store: EventStore,
    policy: PolicyConfig = DEFAULT_POLICY_CONFIG
  ) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: QueryActiveStateRequest = {}): Promise<QueryActiveStateResponse> {
    const allEvents = await this.store.getAllEvents();
    const projection = fold(allEvents, this.policy);

    const facts: ActiveFact[] = [];
    for (const [key, factList] of projection.active_facts.entries()) {
      if (!request.anchor || key.startsWith(request.anchor)) {
        facts.push(...factList);
      }
    }

    const conflicts: ConflictState[] = [];
    for (const [key, conflict] of projection.conflicts.entries()) {
      if (!request.anchor || key.startsWith(request.anchor)) {
        conflicts.push(conflict);
      }
    }

    // Formateamos un bloque conciso y directo para el prompt de Antigravity
    const formattedContext = this.formatContext(facts, conflicts);

    return {
      facts,
      conflicts,
      formattedContext,
    };
  }

  private formatContext(facts: ActiveFact[], conflicts: ConflictState[]): string {
    const lines: string[] = ['[CANON ACTIVE MEMORY]'];

    if (conflicts.length > 0) {
      lines.push('⚠️ CONFLICTOS PENDIENTES QUE REQUIEREN ACLARACION:');
      for (const c of conflicts) {
        lines.push(`- Key '${c.entity_key}': ${c.reason}`);
      }
    }

    if (facts.length > 0) {
      lines.push('HECHOS ACTIVOS:');
      for (const f of facts) {
        const hasDispute = conflicts.some((c) => c.entity_key === f.entity_key);
        const disputeTag = hasDispute ? ' ⚠️ [EN DISPUTA]' : '';
        lines.push(`- [${f.entity_key}] = ${f.value} (id: ${f.source_event_id}, authority: ${f.authority})${disputeTag}`);
      }
    } else if (conflicts.length === 0) {
      lines.push('(Sin hechos activos registrados)');
    }

    return lines.join('\n');
  }
}
