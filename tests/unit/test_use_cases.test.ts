// tests/unit/test_use_cases.test.ts
// Tests unitarios de los casos de uso principales.

import test from 'node:test';
import assert from 'node:assert';
import { InMemoryEventStore } from '../../src/adapters/storage/in_memory.ts';
import { AssertFactUseCase, MAX_ASSERTIONS_PER_TURN } from '../../src/use_cases/assert_fact.ts';
import { QueryActiveStateUseCase } from '../../src/use_cases/query_active_state.ts';
import { ResolveConflictUseCase } from '../../src/use_cases/resolve_conflict.ts';
import { Authority } from '../../src/domain/models.ts';

test('Use Case: Limite anti-loop bloquea aserciones excesivas en un turno', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);

  // Turn count por debajo del limite: permitido
  const res1 = await assertCase.execute({
    entity_key: 'convention:formatting',
    slot_type: 'SINGLE_VALUED',
    value: 'prettier',
    authority: Authority.USER_EXPLICIT,
    turn_count: 2,
  });
  assert.strictEqual(res1.ok, true);

  // Turn count supera el tope anti-loop: rechazado
  const res2 = await assertCase.execute({
    entity_key: 'convention:formatting',
    slot_type: 'SINGLE_VALUED',
    value: 'biome',
    authority: Authority.USER_EXPLICIT,
    turn_count: MAX_ASSERTIONS_PER_TURN,
  });
  assert.strictEqual(res2.ok, false);
  assert.match(res2.error!, /Tope anti-loop alcanzado/);
});

test('Use Case: QueryActiveState filtra por anchor y formatea contexto para prompt', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);
  const queryCase = new QueryActiveStateUseCase(store);

  await assertCase.execute({
    entity_key: 'dep:tailwindcss',
    slot_type: 'SINGLE_VALUED',
    value: 'v4',
    authority: Authority.USER_EXPLICIT,
  });

  await assertCase.execute({
    entity_key: 'db:dialect',
    slot_type: 'SINGLE_VALUED',
    value: 'postgresql',
    authority: Authority.USER_EXPLICIT,
  });

  // Consulta general
  const allState = await queryCase.execute();
  assert.strictEqual(allState.facts.length, 2);
  assert.match(allState.formattedContext, /dep:tailwindcss/);
  assert.match(allState.formattedContext, /db:dialect/);

  // Consulta filtrada por anchor 'db:'
  const dbState = await queryCase.execute({ anchor: 'db:' });
  assert.strictEqual(dbState.facts.length, 1);
  assert.strictEqual(dbState.facts[0].entity_key, 'db:dialect');
});

test('Use Case: ResolveConflict entierra el conflicto y activa el hecho ganador', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);
  const resolveCase = new ResolveConflictUseCase(store);
  const queryCase = new QueryActiveStateUseCase(store);

  // Disparamos un conflicto en db:pk_format
  const a1 = await assertCase.execute({
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'uuidv4',
    authority: Authority.USER_EXPLICIT,
  });

  const a2 = await assertCase.execute({
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'cuid2',
    authority: Authority.USER_EXPLICIT,
  });

  const conflictState = await queryCase.execute({ anchor: 'db:pk_format' });
  assert.strictEqual(conflictState.conflicts.length, 1);
  assert.strictEqual(conflictState.facts.length, 0);

  // Resolvemos el conflicto
  const res = await resolveCase.execute({
    entity_key: 'db:pk_format',
    resolves_event_ids: [a1.event_id!, a2.event_id!],
    winning_value: 'uuidv4',
    authority: Authority.USER_EXPLICIT,
  });
  assert.strictEqual(res.ok, true);

  const cleanState = await queryCase.execute({ anchor: 'db:pk_format' });
  assert.strictEqual(cleanState.conflicts.length, 0);
  assert.strictEqual(cleanState.facts.length, 1);
  assert.strictEqual(cleanState.facts[0].value, 'uuidv4');
});
