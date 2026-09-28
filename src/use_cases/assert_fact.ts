// src/use_cases/assert_fact.ts
// Caso de uso: el agente o el usuario afirman un hecho en Canon.
// Aplica filtro defensivo de credenciales, fail-closed por namespace y validacion de hojas.

import { randomUUID } from 'node:crypto';
import type { EventStore } from '../ports/event_store.ts';
import type { SlotCardinality, AuthorityLevel, AssertEvent, Projection } from '../domain/models.ts';
import { validateAssertionSecurity } from '../domain/security.ts';
import { fold } from '../domain/fold.ts';
import type { PolicyConfig } from '../domain/policy.ts';
import { DEFAULT_POLICY_CONFIG, isKeyRegistered, extractSubsystemAndLeaf } from '../domain/policy.ts';

export interface AssertFactRequest {
  entity_key: string;
  slot_type: SlotCardinality;
  value: string;
  authority: AuthorityLevel;
  supersedes_event_id?: string;
  new_leaf?: boolean; // Permite crear una nueva hoja bajo un subsistema conocido
  source_session_id?: string;
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
    // 1. Fail-closed: La clave debe pertenecer a un namespace registrado en canon_policy.yaml
    if (!isKeyRegistered(request.entity_key, this.policy)) {
      const validNamespaces = Object.keys(this.policy.rules);
      return {
        ok: false,
        error: `❌ Clave '${request.entity_key}' no pertenece a ningún namespace registrado. Namespaces válidos: [${validNamespaces.join(', ')}]. Para registrar un nuevo namespace, ejecutá 'npm run canon register <namespace>'.`,
      };
    }

    // 2. Filtro de seguridad: Cero contraseñas o tokens
    const sec = validateAssertionSecurity(request.value);
    if (!sec.allowed) {
      return {
        ok: false,
        error: sec.reason,
      };
    }

    // 3. Crear el evento inmutable con ID seguro
    const eventId = `evt_${randomUUID()}`;
    const event: AssertEvent = {
      id: eventId,
      schema_version: 1,
      entity_key: request.entity_key,
      logical_ts: 0,
      slot_type: request.slot_type,
      value: request.value,
      authority: request.authority,
      supersedes_event_id: request.supersedes_event_id,
      source_session_id: request.source_session_id,
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };

    // 4. Ejecutar validacion de subsistema y append de forma atomica bajo Lock
    const executeInLock = async (): Promise<AssertFactResult> => {
      const { subsystem, leaf } = extractSubsystemAndLeaf(request.entity_key);

      // Verificacion de hojas para evitar bifurcacion lexica (ej: branch_naming vs branch_format)
      const allEvents = await this.store.getAllEvents();
      const existingLeaves = Array.from(
        new Set(
          allEvents
            .filter((e) => e.entity_key.startsWith(subsystem + ':'))
            .map((e) => extractSubsystemAndLeaf(e.entity_key).leaf)
        )
      );

      if (existingLeaves.length > 0 && !existingLeaves.includes(leaf) && !request.new_leaf) {
        return {
          ok: false,
          error: `❌ Hoja no reconocida '${leaf}' en subsistema '${subsystem}'. Hojas conocidas: [${existingLeaves.join(', ')}]. Si realmente deseás crear una hoja nueva, pasá 'new_leaf: true'.`,
        };
      }

      // Persistir de forma atomica
      if (this.store.appendUnlocked) {
        this.store.appendUnlocked(event);
      } else {
        await this.store.append(event);
      }

      // Reconstruir proyeccion con los eventos actualizados
      const updatedEvents = [...allEvents, event];
      const projection = fold(updatedEvents, this.policy);

      return {
        ok: true,
        event_id: eventId,
        projection,
      };
    };

    if (this.store.withLock) {
      return await this.store.withLock(executeInLock);
    }
    return await executeInLock();
  }
}
