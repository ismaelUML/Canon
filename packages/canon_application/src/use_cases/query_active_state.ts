// packages/canon_application/src/use_cases/query_active_state.ts
// Caso de uso: consulta determinista del estado activo de memoria.
// Complejidad ciclomatica <= 5 por funcion garantizada.
// Soporte de AbortSignal para corte de transacciones (Seccion 5.4).

import type { EventStore, ActiveFact, ConflictState, PolicyConfig } from '../../../canon_domain/src/index.ts';
import { fold, DEFAULT_POLICY_CONFIG } from '../../../canon_domain/src/index.ts';

export interface QueryActiveStateRequest {
  anchor?: string;
  signal?: AbortSignal;
}

export interface QueryActiveStateResponse {
  facts: ActiveFact[];
  conflicts: ConflictState[];
  formattedContext: string;
}

export function formatDegradedNotice(degradedCount: number): string | null {
  if (degradedCount <= 0) return null;
  return `⚠️ ALERTA DE SEGURIDAD: ${degradedCount} hecho(s) tienen firma HMAC ausente o inválida y fueron degradados a autoridad 40 (posible cambio de máquina, falta de clave en ~/.canon/secret.key o evento de compañero de equipo).`;
}

export function formatConflictsSection(conflicts: ConflictState[]): string[] {
  if (conflicts.length === 0) return [];
  const lines: string[] = ['⚠️ CONFLICTOS PENDIENTES QUE REQUIEREN ACLARACION:'];
  for (const c of conflicts) {
    lines.push(`- Key '${c.entity_key}': ${c.reason}`);
  }
  return lines;
}

export function formatFactsSection(facts: ActiveFact[], conflicts: ConflictState[]): string[] {
  if (facts.length === 0) return [];
  const lines: string[] = ['HECHOS ACTIVOS:'];
  for (const f of facts) {
    const hasDispute = conflicts.some((c) => c.entity_key === f.entity_key);
    const disputeTag = hasDispute ? ' ⚠️ [EN DISPUTA]' : '';
    lines.push(`- [${f.entity_key}] = ${f.value} (id: ${f.source_event_id}, authority: ${f.authority})${disputeTag}`);
  }
  return lines;
}

export class QueryActiveStateUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(store: EventStore, policy: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: QueryActiveStateRequest = {}): Promise<QueryActiveStateResponse> {
    if (request.signal?.aborted) {
      throw new Error('Operación cancelada por AbortSignal');
    }

    const allEvents = await this.store.getAllEvents(request.signal);
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

    const formattedContext = this.formatContext(facts, conflicts, projection.degraded_events_count);

    return {
      facts,
      conflicts,
      formattedContext,
    };
  }

  private formatContext(facts: ActiveFact[], conflicts: ConflictState[], degradedCount: number = 0): string {
    const lines: string[] = ['[CANON ACTIVE MEMORY]'];

    const notice = formatDegradedNotice(degradedCount);
    if (notice) lines.push(notice);

    lines.push(...formatConflictsSection(conflicts));
    lines.push(...formatFactsSection(facts, conflicts));

    if (facts.length === 0 && conflicts.length === 0) {
      lines.push('(Sin hechos activos registrados)');
    }

    return lines.join('\n');
  }
}
