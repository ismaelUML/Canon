// tests/benchmark/test_staleness_ci.test.ts
// TEST #1 DE CI: BENCHMARK DE OBSOLESCENCIA (STALENESS BENCHMARK)
// Esta es la prueba de fuego de Canon. Si este test pasa, garantizamos matematicamente
// que jamas se le inyectara a Antigravity un hecho muerto, contradictorio o sobreescrito
// por una herramienta de menor autoridad.

import test from 'node:test';
import assert from 'node:assert';
import { InMemoryEventStore } from '../../packages/canon_infrastructure/src/storage/in_memory.ts';
import { fold } from '../../packages/canon_domain/src/fold.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';
import type { AssertEvent, ResolveConflictEvent } from '../../packages/canon_domain/src/models.ts';
import { DEFAULT_POLICY_CONFIG } from '../../packages/canon_domain/src/policy.ts';

test('Benchmark 1: Supersesion limpia en slot unico (Vitest mata a Jest)', async () => {
  const store = new InMemoryEventStore();

  // Sesion 1: El proyecto arranca usando Jest
  const evtJest: AssertEvent = {
    id: 'evt_001',
    entity_key: 'dep:test_runner',
    slot_type: 'SINGLE_VALUED',
    value: 'jest',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_1',
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  };
  await store.append(evtJest);

  // Sesion 2: El usuario migra a Vitest en el mismo slot unico
  const evtVitest: AssertEvent = {
    id: 'evt_002',
    entity_key: 'dep:test_runner',
    slot_type: 'SINGLE_VALUED',
    value: 'vitest',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_2',
    created_at: '2026-02-01T10:00:00Z',
    type: 'ASSERT',
  };
  await store.append(evtVitest);

  // Ejecutamos la proyeccion pura
  const events = await store.getAllEvents();
  const projection = fold(events, DEFAULT_POLICY_CONFIG);

  // Aserciones criticas:
  const active = projection.active_facts.get('dep:test_runner');
  assert.ok(active, 'Debe existir un hecho activo para dep:test_runner');
  assert.strictEqual(active.length, 1, 'Solo debe haber exactamente 1 valor activo');
  assert.strictEqual(active[0].value, 'vitest', 'El valor activo tiene que ser Vitest');
  assert.ok(
    projection.superseded_event_ids.has('evt_001'),
    'El evento de Jest (evt_001) debe estar marcado como obsoleto/superseded'
  );
});

test('Benchmark 2: Conflicto de misma autoridad en namespace critico (UUID vs ULID)', async () => {
  const store = new InMemoryEventStore();

  // Sesion 1: Se establece UUIDv4 como estandar de base de datos
  const evtUuid: AssertEvent = {
    id: 'evt_db_1',
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'uuidv4',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_1',
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  };
  await store.append(evtUuid);

  // Sesion 5: El usuario dice al pasar "generame una entidad con ULID" (misma autoridad)
  const evtUlid: AssertEvent = {
    id: 'evt_db_2',
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'ulid',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_5',
    created_at: '2026-02-15T10:00:00Z',
    type: 'ASSERT',
  };
  await store.append(evtUlid);

  const events = await store.getAllEvents();
  const projection = fold(events, DEFAULT_POLICY_CONFIG);

  // Como 'db:*' tiene politica 'interrupt', NO debe ganar ULID silenciosamente
  assert.ok(
    projection.conflicts.has('db:pk_format'),
    'db:pk_format DEBE disparar un estado de CONFLICT'
  );
  assert.strictEqual(
    projection.active_facts.get('db:pk_format'),
    undefined,
    'No debe filtrarse ningun hecho activo dudoso al contexto del agente'
  );

  const conflict = projection.conflicts.get('db:pk_format')!;
  assert.strictEqual(conflict.conflicting_events.length, 2);
});

test('Benchmark 3: Resolucion explicita de conflicto (RESOLVE_CONFLICT)', async () => {
  const store = new InMemoryEventStore();

  // Reproducimos el conflicto UUID vs ULID
  await store.append({
    id: 'evt_db_1',
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'uuidv4',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  });
  await store.append({
    id: 'evt_db_2',
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'ulid',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-02-15T10:00:00Z',
    type: 'ASSERT',
  });

  // Sesion 6: El usuario aclara "Quedamos en UUIDv4 para todas las tablas"
  const evtResolution: ResolveConflictEvent = {
    id: 'evt_db_res',
    entity_key: 'db:pk_format',
    authority: Authority.USER_EXPLICIT,
    resolves_event_ids: ['evt_db_1', 'evt_db_2'],
    winning_value: 'uuidv4',
    source_session_id: 'session_6',
    created_at: '2026-02-15T11:00:00Z',
    type: 'RESOLVE_CONFLICT',
  };
  await store.append(evtResolution);

  const events = await store.getAllEvents();
  const projection = fold(events, DEFAULT_POLICY_CONFIG);

  // El conflicto debe haber desaparecido y UUIDv4 debe ser el hecho activo unico
  assert.strictEqual(
    projection.conflicts.has('db:pk_format'),
    false,
    'El conflicto debio haber quedado cerrado'
  );
  const active = projection.active_facts.get('db:pk_format');
  assert.ok(active);
  assert.strictEqual(active[0].value, 'uuidv4');
  assert.ok(projection.superseded_event_ids.has('evt_db_1'));
  assert.ok(projection.superseded_event_ids.has('evt_db_2'));
});

test('Benchmark 4: Jerarquia de autoridad (Una deduccion vaga no voltea una decision del usuario)', async () => {
  const store = new InMemoryEventStore();

  // El usuario dijo expresamente cookies seguras
  await store.append({
    id: 'evt_sec_1',
    entity_key: 'security:token_storage',
    slot_type: 'SINGLE_VALUED',
    value: 'http_only_cookie',
    authority: Authority.USER_EXPLICIT, // 100
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  });

  // Una herramienta o inferencia intenta guardar local_storage_jwt
  await store.append({
    id: 'evt_sec_2',
    entity_key: 'security:token_storage',
    slot_type: 'SINGLE_VALUED',
    value: 'local_storage_jwt',
    authority: Authority.INFERRED, // 40 (inferior)
    created_at: '2026-02-01T10:00:00Z',
    type: 'ASSERT',
  });

  const events = await store.getAllEvents();
  const projection = fold(events, DEFAULT_POLICY_CONFIG);

  const active = projection.active_facts.get('security:token_storage');
  assert.ok(active);
  assert.strictEqual(
    active[0].value,
    'http_only_cookie',
    'La asercion con menor autoridad debio ser ignorada sin corromper el hecho original'
  );
  assert.strictEqual(
    projection.superseded_event_ids.has('evt_sec_1'),
    false,
    'El hecho original no debe estar marcado como obsoleto'
  );
});

test('Benchmark 5: Slots acumulativos no sufren supersesion accidental', async () => {
  const store = new InMemoryEventStore();

  // Dos quirks descubiertos en dias distintos sobre autenticacion
  await store.append({
    id: 'evt_acc_1',
    entity_key: 'learned:gotchas:auth',
    slot_type: 'ACCUMULATIVE',
    value: 'Postgres trata NULL como valor unico a menos que se use NULLS NOT DISTINCT',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  });

  await store.append({
    id: 'evt_acc_2',
    entity_key: 'learned:gotchas:auth',
    slot_type: 'ACCUMULATIVE',
    value: 'Safari descarta cookies sin flag Secure incluso en localhost',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-10T10:00:00Z',
    type: 'ASSERT',
  });

  const events = await store.getAllEvents();
  const projection = fold(events, DEFAULT_POLICY_CONFIG);

  const active = projection.active_facts.get('learned:gotchas:auth');
  assert.ok(active);
  assert.strictEqual(active.length, 2, 'Ambos gotchas deben convivir en el slot acumulativo');
  assert.strictEqual(
    projection.superseded_event_ids.size,
    0,
    'Ningun gotcha debio haber sido descartado'
  );
});
