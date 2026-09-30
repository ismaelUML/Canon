// packages/canon_domain/src/fold.ts
// Reductor puro: transforma el historial inmutable de eventos en la proyeccion activa.
// Cero I/O, cero librerias, complejidad ciclomatica <= 5 por funcion garantizada.

import type {
  MemoryEvent,
  AssertEvent,
  SupersedeEvent,
  ResolveConflictEvent,
  ActiveFact,
  ConflictState,
  Projection,
} from './models.ts';
import type { PolicyConfig } from './policy.ts';
import { DEFAULT_POLICY_CONFIG, resolvePolicy } from './policy.ts';

export function createEmptyProjection(): Projection {
  return {
    active_facts: new Map<string, ActiveFact[]>(),
    conflicts: new Map<string, ConflictState>(),
    superseded_event_ids: new Set<string>(),
  };
}

export const MAX_OPEN_DISPUTES = 5;

export type SignatureVerifier = (event: MemoryEvent) => boolean;

export function deduplicateEvents(events: MemoryEvent[]): MemoryEvent[] {
  const seenIds = new Set<string>();
  const uniqueEvents: MemoryEvent[] = [];
  for (const e of events) {
    if (!seenIds.has(e.id)) {
      seenIds.add(e.id);
      uniqueEvents.push(e);
    }
  }
  return uniqueEvents;
}

export function sortEvents(events: MemoryEvent[]): MemoryEvent[] {
  return events.sort((a, b) =>
    (a.logical_ts ?? 0) - (b.logical_ts ?? 0) || a.id.localeCompare(b.id)
  );
}

export function resolveEffectiveEvent(
  rawEvent: MemoryEvent,
  verifySignature?: SignatureVerifier
): { event: MemoryEvent; degraded: boolean } {
  if (!verifySignature || rawEvent.authority <= 40) {
    return { event: rawEvent, degraded: false };
  }
  if (verifySignature(rawEvent)) {
    return { event: rawEvent, degraded: false };
  }
  return { event: { ...rawEvent, authority: 40 }, degraded: true };
}

export function fold(
  events: MemoryEvent[],
  policy: PolicyConfig = DEFAULT_POLICY_CONFIG,
  verifySignature?: SignatureVerifier
): Projection {
  const projection = createEmptyProjection();
  projection.degraded_events_count = 0;

  const sorted = sortEvents(deduplicateEvents(events));
  for (const rawEvent of sorted) {
    const { event, degraded } = resolveEffectiveEvent(rawEvent, verifySignature);
    if (degraded) {
      projection.degraded_events_count = (projection.degraded_events_count ?? 0) + 1;
    }
    applyEvent(projection, event, policy);
  }
  return projection;
}

function applyEvent(
  projection: Projection,
  event: MemoryEvent,
  policy: PolicyConfig
): void {
  switch (event.type) {
    case 'ASSERT':
      applyAssert(projection, event, policy);
      break;
    case 'SUPERSEDE':
      applySupersede(projection, event);
      break;
    case 'RESOLVE_CONFLICT':
      applyResolveConflict(projection, event);
      break;
  }
}

function applyAssert(
  projection: Projection,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  if (event.slot_type === 'ACCUMULATIVE') {
    handleAccumulativeAssert(projection, event);
    return;
  }
  handleSingleValuedAssert(projection, event, policy);
}

function handleAccumulativeAssert(projection: Projection, event: AssertEvent): void {
  const existing = projection.active_facts.get(event.entity_key) ?? [];
  const newFact: ActiveFact = {
    id: event.id,
    entity_key: event.entity_key,
    slot_type: 'ACCUMULATIVE',
    value: event.value,
    authority: event.authority,
    source_event_id: event.id,
    updated_at: event.created_at,
  };
  projection.active_facts.set(event.entity_key, [...existing, newFact]);
}

function tryHandleIdenticalValue(projection: Projection, existing: ActiveFact, event: AssertEvent): boolean {
  if (existing.value !== event.value) return false;
  if (event.authority > existing.authority) {
    projection.superseded_event_ids.add(existing.source_event_id);
    setSingleFact(projection, event);
  }
  return true;
}

function tryExplicitSupersede(projection: Projection, existing: ActiveFact, event: AssertEvent): boolean {
  const isMatch = Boolean(event.supersedes_event_id && event.supersedes_event_id === existing.source_event_id);
  if (!isMatch) return false;
  if (event.authority >= existing.authority) {
    projection.superseded_event_ids.add(existing.source_event_id);
    setSingleFact(projection, event);
    return true;
  }
  return false;
}

function recordDispute(projection: Projection, existing: ActiveFact, event: AssertEvent): void {
  const canRecord = projection.conflicts.size < MAX_OPEN_DISPUTES || projection.conflicts.has(event.entity_key);
  if (!canRecord) return;

  const disputeConflict: ConflictState = {
    entity_key: event.entity_key,
    conflicting_events: [
      {
        id: existing.source_event_id,
        entity_key: existing.entity_key,
        type: 'ASSERT',
        slot_type: existing.slot_type,
        value: existing.value,
        authority: existing.authority,
        created_at: existing.updated_at,
      },
      event,
    ],
    reason: `Desafío: el hecho activo (autoridad ${existing.authority}: '${existing.value}') fue disputado por inferencia de menor autoridad (${event.authority}: '${event.value}')`,
    detected_at: event.created_at,
  };
  projection.conflicts.set(event.entity_key, disputeConflict);
}

function promoteHigherAuthorityFact(projection: Projection, existing: ActiveFact, event: AssertEvent): void {
  projection.superseded_event_ids.add(existing.source_event_id);
  setSingleFact(projection, event);
}

function tryHandleDirectUpdate(projection: Projection, existing: ActiveFact, event: AssertEvent): boolean {
  if (tryHandleIdenticalValue(projection, existing, event)) return true;
  return tryExplicitSupersede(projection, existing, event);
}

function handleAuthorityDifference(
  projection: Projection,
  existing: ActiveFact,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  if (event.authority < existing.authority) {
    recordDispute(projection, existing, event);
    return;
  }
  if (event.authority > existing.authority) {
    promoteHigherAuthorityFact(projection, existing, event);
    return;
  }
  handleSameAuthorityConflict(projection, existing, event, policy);
}

function handleSingleValuedAssert(
  projection: Projection,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  const existing = (projection.active_facts.get(event.entity_key) ?? [])[0];
  if (!existing) {
    setSingleFact(projection, event);
    return;
  }
  if (tryHandleDirectUpdate(projection, existing, event)) return;
  handleAuthorityDifference(projection, existing, event, policy);
}

function recordInterruptConflict(projection: Projection, existing: ActiveFact, event: AssertEvent): void {
  const conflict: ConflictState = {
    entity_key: event.entity_key,
    conflicting_events: [
      {
        id: existing.source_event_id,
        entity_key: existing.entity_key,
        type: 'ASSERT',
        slot_type: existing.slot_type,
        value: existing.value,
        authority: existing.authority,
        created_at: existing.updated_at,
      },
      event,
    ],
    reason: `Misma autoridad (${event.authority}) afirmando valores opuestos sin supersedes explicito`,
    detected_at: event.created_at,
  };
  projection.conflicts.set(event.entity_key, conflict);
  projection.active_facts.delete(event.entity_key);
}

function handleSameAuthorityConflict(
  projection: Projection,
  existing: ActiveFact,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  const currentPolicy = resolvePolicy(event.entity_key, policy);
  if (currentPolicy === 'interrupt') {
    recordInterruptConflict(projection, existing, event);
    return;
  }
  projection.superseded_event_ids.add(existing.source_event_id);
  setSingleFact(projection, event);
}

function setSingleFact(projection: Projection, event: AssertEvent): void {
  const newFact: ActiveFact = {
    id: event.id,
    entity_key: event.entity_key,
    slot_type: 'SINGLE_VALUED',
    value: event.value,
    authority: event.authority,
    source_event_id: event.id,
    updated_at: event.created_at,
  };
  projection.active_facts.set(event.entity_key, [newFact]);
  projection.conflicts.delete(event.entity_key);
}

function applySupersede(projection: Projection, event: SupersedeEvent): void {
  projection.superseded_event_ids.add(event.supersedes_event_id);
  const newFact: ActiveFact = {
    id: event.id,
    entity_key: event.entity_key,
    slot_type: 'SINGLE_VALUED',
    value: event.new_value,
    authority: event.authority,
    source_event_id: event.id,
    updated_at: event.created_at,
  };
  projection.active_facts.set(event.entity_key, [newFact]);
  projection.conflicts.delete(event.entity_key);
}

function applyResolveConflict(
  projection: Projection,
  event: ResolveConflictEvent
): void {
  for (const conflictId of event.resolves_event_ids) {
    projection.superseded_event_ids.add(conflictId);
  }
  const resolvedFact: ActiveFact = {
    id: event.id,
    entity_key: event.entity_key,
    slot_type: 'SINGLE_VALUED',
    value: event.winning_value,
    authority: event.authority,
    source_event_id: event.id,
    updated_at: event.created_at,
  };
  projection.active_facts.set(event.entity_key, [resolvedFact]);
  projection.conflicts.delete(event.entity_key);
}
