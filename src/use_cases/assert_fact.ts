// src/use_cases/assert_fact.ts
// Caso de uso: el agente o el usuario afirman un hecho en Canon.
// Aplica filtro defensivo de credenciales y limite anti-loop por turno.

import { randomUUID } from 'node:crypto';
import type { EventStore } from '../ports/event_store.ts';
import type { SlotCardinality, AuthorityLevel, AssertEvent, Projection } from '../domain/models.ts';
import { validateAssertionSecurity } from '../domain/security.ts';
import { fold } from '../domain/fold.ts';
import type { PolicyConfig } from '../domain/policy.ts';
import { DEFAULT_POLICY_CONFIG } from '../domain/policy.ts';

export const MAX_ASSERTIONS_PER_TURN = 5;

export interface AssertFactRequest {
  entity_key: string;
  slot_type: SlotCardinality;
  value: string;
  authority: AuthorityLevel;
  source_session_id?: string;
  turn_count?: number; // Para limitar loops descontrolados del agente
}

export interface AssertFactResult {
  ok: boolean;
  event_id?: string;
  projection?: Projection;
  error?: string;
}

export class AssertFactUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(
    store: EventStore,
    policy: PolicyConfig = DEFAULT_POLICY_CONFIG
  ) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: AssertFactRequest): Promise<AssertFactResult> {
    // 1. Freno de mano: Limite anti-loop de aserciones por turno
    if (request.turn_count && request.turn_count >= MAX_ASSERTIONS_PER_TURN) {
      return {
        ok: false,
        error: `Tope anti-loop alcanzado: maximo ${MAX_ASSERTIONS_PER_TURN} aserciones por turno.`,
      };
    }

    // 2. Filtro de seguridad: Cero contrasenas o tokens
    const sec = validateAssertionSecurity(request.value);
    if (!sec.allowed) {
      return {
        ok: false,
        error: sec.reason,
      };
    }

    // 3. Crear el evento inmutable con ID criptograficamente seguro (RFC 4122)
    const eventId = `evt_${randomUUID()}`;
    const event: AssertEvent = {
      id: eventId,
      entity_key: request.entity_key,
      slot_type: request.slot_type,
      value: request.value,
      authority: request.authority,
      source_session_id: request.source_session_id,
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };

    // 4. Persistir en el puerto hexagonal
    await this.store.append(event);

    // 5. Reconstruir proyeccion activa
    const allEvents = await this.store.getAllEvents();
    const projection = fold(allEvents, this.policy);

    return {
      ok: true,
      event_id: eventId,
      projection,
    };
  }
}
