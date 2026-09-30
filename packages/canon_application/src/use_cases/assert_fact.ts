// packages/canon_application/src/use_cases/assert_fact.ts
// Caso de uso: afirmacion atomica de hechos bajo arquitectura hexagonal.
// Complejidad ciclomatica <= 5 garantizada en todas las subfunciones.
// Soporte de AbortSignal para cancelacion reactiva en cascada (Seccion 5.4).

import { randomUUID } from 'node:crypto';
import type { EventStore, SlotCardinality, AuthorityLevel, AssertEvent, Projection, PolicyConfig, MemoryEvent } from '../../../canon_domain/src/index.ts';
import { validateAssertionSecurity, fold, DEFAULT_POLICY_CONFIG, isKeyRegistered, extractSubsystemAndLeaf } from '../../../canon_domain/src/index.ts';

export interface AssertFactRequest {
  entity_key: string;
  slot_type: SlotCardinality;
  value: string;
  authority: AuthorityLevel;
  supersedes_event_id?: string;
  source_session_id?: string;
  allow_new_leaf?: boolean;
  signal?: AbortSignal;
}

export interface AssertFactResult {
  ok: boolean;
  event_id?: string;
  projection?: Projection;
  error?: string;
}

export function validateNamespaceRegistration(entityKey: string, policy: PolicyConfig): string | null {
  if (isKeyRegistered(entityKey, policy)) {
    return null;
  }
  const validNamespaces = Object.keys(policy.rules);
  return `❌ Clave '${entityKey}' no pertenece a ningún namespace registrado. Namespaces válidos: [${validNamespaces.join(', ')}]. Para registrar un nuevo namespace, ejecutá 'npm run canon register <namespace>'.`;
}

export function validateFactSecurity(value: string): string | null {
  const sec = validateAssertionSecurity(value);
  if (!sec.allowed) {
    return sec.reason ?? 'Rechazado por politica de seguridad';
  }
  return null;
}

export function buildAssertEvent(request: AssertFactRequest): AssertEvent {
  return {
    id: `evt_${randomUUID()}`,
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
}

export function validateLeafOrReject(
  allEvents: MemoryEvent[],
  subsystem: string,
  leaf: string,
  authority: number
): string | null {
  const existingLeaves = Array.from(
    new Set(
      allEvents
        .filter((e) => e.entity_key.startsWith(subsystem + ':'))
        .map((e) => extractSubsystemAndLeaf(e.entity_key).leaf)
    )
  );

  const isUnknown = existingLeaves.length > 0 && !existingLeaves.includes(leaf);
  if (isUnknown && authority <= 40) {
    return `❌ Hoja no reconocida '${leaf}' en subsistema '${subsystem}'. Hojas conocidas: [${existingLeaves.join(', ')}]. Si es una clave nueva deliberada (y no un sinónimo accidental), enviá 'allow_new_leaf: true' o agregala con: 'npm run canon learn ... <valor>'.`;
  }
  return null;
}

export function isLeafPermitted(subsystem: string, slotType: SlotCardinality, allowNewLeaf?: boolean): boolean {
  if (allowNewLeaf) return true;
  if (subsystem.startsWith('learned')) return true;
  return slotType === 'ACCUMULATIVE';
}

export class AssertFactUseCase {
  private store: EventStore;
  private policy: PolicyConfig;

  constructor(store: EventStore, policy: PolicyConfig = DEFAULT_POLICY_CONFIG) {
    this.store = store;
    this.policy = policy;
  }

  async execute(request: AssertFactRequest): Promise<AssertFactResult> {
    if (request.signal?.aborted) {
      return { ok: false, error: 'Operación cancelada por AbortSignal' };
    }

    const nsError = validateNamespaceRegistration(request.entity_key, this.policy);
    if (nsError) return { ok: false, error: nsError };

    const secError = validateFactSecurity(request.value);
    if (secError) return { ok: false, error: secError };

    const event = buildAssertEvent(request);
    return await this.dispatchAppend(event, request);
  }

  private async dispatchAppend(event: AssertEvent, request: AssertFactRequest): Promise<AssertFactResult> {
    const action = () => this.runAtomicAppend(event, request);
    if (this.store.withLock) {
      return await this.store.withLock(action, request.signal);
    }
    return await action();
  }

  private async runAtomicAppend(event: AssertEvent, request: AssertFactRequest): Promise<AssertFactResult> {
    if (request.signal?.aborted) {
      return { ok: false, error: 'Operación cancelada por AbortSignal' };
    }

    const allEvents = await this.store.getAllEvents(request.signal);
    const leafError = this.checkSubsystemLeaf(request, allEvents);
    if (leafError) {
      return { ok: false, error: leafError };
    }

    await this.persistEvent(event);
    const projection = fold([...allEvents, event], this.policy);

    return {
      ok: true,
      event_id: event.id,
      projection,
    };
  }

  private checkSubsystemLeaf(request: AssertFactRequest, allEvents: MemoryEvent[]): string | null {
    const { subsystem, leaf, hasSubsystem } = extractSubsystemAndLeaf(request.entity_key);
    const permitsNewLeaf = isLeafPermitted(subsystem, request.slot_type, request.allow_new_leaf);
    if (hasSubsystem && !permitsNewLeaf) {
      return validateLeafOrReject(allEvents, subsystem, leaf, request.authority);
    }
    return null;
  }

  private async persistEvent(event: AssertEvent): Promise<void> {
    if (this.store.appendUnlocked) {
      await this.store.appendUnlocked(event);
    } else {
      await this.store.append(event);
    }
  }
}
