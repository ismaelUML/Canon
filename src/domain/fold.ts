// src/domain/fold.ts
// Reductor puro: transforma el historial inmutable de eventos en la proyeccion activa.
// Cero I/O, cero librerias, complejidad ciclomatica <= 5 por funcion.
// Si esto falla, el agente se confunde y empieza a mezclar librerias muertas con vivas.

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

export type SignatureVerifier = (event: MemoryEvent) => boolean;

export function fold(
  events: MemoryEvent[],
  policy: PolicyConfig = DEFAULT_POLICY_CONFIG,
  verifySignature?: SignatureVerifier
): Projection {
  const projection = createEmptyProjection();
  // Orden causal total: Git 3-way merge no garantiza el orden de las lineas en texto,
  // pero el reloj logico garantiza que A->B se procesa siempre en orden causal deterministico.
  const sorted = [...events].sort((a, b) => 
    (a.logical_ts ?? 0) - (b.logical_ts ?? 0) || a.id.localeCompare(b.id)
  );
  for (const rawEvent of sorted) {
    // Si hay un verificador activo y el evento afirma autoridad > 40 sin firma valida,
    // se degrada estrictamente a INFERRED (40) para neutralizar manipulaciones o inyecciones.
    let event = rawEvent;
    if (verifySignature && rawEvent.authority > 40) {
      if (!verifySignature(rawEvent)) {
        event = { ...rawEvent, authority: 40 };
      }
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

function handleSingleValuedAssert(
  projection: Projection,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  const existingList = projection.active_facts.get(event.entity_key) ?? [];
  const existing = existingList[0];

  // Si no habia nada previo, se inserta directamente
  if (!existing) {
    setSingleFact(projection, event);
    return;
  }

  // Si el valor es exactamente el mismo: si la autoridad entrante es mayor, promovemos la autoridad; si no, idempotencia
  if (existing.value === event.value) {
    if (event.authority > existing.authority) {
      projection.superseded_event_ids.add(existing.source_event_id);
      setSingleFact(projection, event);
    }
    return;
  }

  // Si el nuevo evento intenta superseder explicitamente al anterior
  if (event.supersedes_event_id && event.supersedes_event_id === existing.source_event_id) {
    if (event.authority >= existing.authority) {
      projection.superseded_event_ids.add(existing.source_event_id);
      setSingleFact(projection, event);
      return;
    }
  }

  // Menor autoridad no puede voltear una decision de mayor autoridad, pero si el valor difiere,
  // se registra como DESAFIO (disputa) para no perder la señal en query_active_state
  if (event.authority < existing.authority) {
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
    return;
  }

  // Mayor autoridad gana y reemplaza limpiamente
  if (event.authority > existing.authority) {
    projection.superseded_event_ids.add(existing.source_event_id);
    setSingleFact(projection, event);
    return;
  }

  // Misma autoridad y distinto valor: aca se bifurca segun politica
  handleSameAuthorityConflict(projection, existing, event, policy);
}

function handleSameAuthorityConflict(
  projection: Projection,
  existing: ActiveFact,
  event: AssertEvent,
  policy: PolicyConfig
): void {
  const currentPolicy = resolvePolicy(event.entity_key, policy);

  if (currentPolicy === 'interrupt') {
    // Si la politica es interrupt, marcamos el conflicto y vaciamos el hecho activo
    // para no filtrar verdades a medias al agente.
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
    return;
  }

  // Para soft_lww o auto_latest, el nuevo valor desplaza al anterior
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
  // Si habia un conflicto previo pendiente y se resolvio, lo limpiamos
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
  // Matamos todos los eventos que estaban en pugna
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
