// tests/unit/test_use_cases.test.ts
// Tests unitarios de los casos de uso principales.

import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryEventStore } from '../../packages/canon_infrastructure/src/storage/in_memory.ts';
import { AssertFactUseCase } from '../../packages/canon_application/src/use_cases/assert_fact.ts';
import { QueryActiveStateUseCase } from '../../packages/canon_application/src/use_cases/query_active_state.ts';
import { ResolveConflictUseCase } from '../../packages/canon_application/src/use_cases/resolve_conflict.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';
import { runCli } from '../../packages/canon_presentation/src/cli/canon_cli.ts';

test('Use Case: Fail-closed rechaza claves fuera de namespaces registrados', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);

  // Clave en namespace no registrado (ej: arch:*)
  const res = await assertCase.execute({
    entity_key: 'arch:pattern:redux',
    slot_type: 'SINGLE_VALUED',
    value: 'toolkit',
    authority: Authority.INFERRED,
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error!, /no pertenece a ningún namespace registrado/);
});

test('Use Case: Validacion de hojas bloquea bifurcacion lexica sin flag new_leaf', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);

  // 1. Establecemos la primera hoja en convention:git
  const res1 = await assertCase.execute({
    entity_key: 'convention:git:branch_naming',
    slot_type: 'SINGLE_VALUED',
    value: 'feat/*',
    authority: Authority.USER_EXPLICIT,
  });
  assert.strictEqual(res1.ok, true);

  // 2. Un agente intenta inventar branch_format sin new_leaf: true
  const res2 = await assertCase.execute({
    entity_key: 'convention:git:branch_format',
    slot_type: 'SINGLE_VALUED',
    value: 'feat/*',
    authority: Authority.INFERRED,
  });
  assert.strictEqual(res2.ok, false);
  assert.match(res2.error!, /Hoja no reconocida 'branch_format'/);
  // 2b. Con flag allow_new_leaf: true, el agente puede registrar deliberadamente una hoja nueva
  const res2b = await assertCase.execute({
    entity_key: 'convention:git:commit_style',
    slot_type: 'SINGLE_VALUED',
    value: 'conventional',
    authority: Authority.INFERRED,
    allow_new_leaf: true,
  });
  assert.strictEqual(res2b.ok, true, 'allow_new_leaf: true debe permitir crear nuevas hojas');

  // 2c. En namespaces naturalmente dinamicos (learned:*), el agente puede aprender novedades sin bloqueo
  const res2c = await assertCase.execute({
    entity_key: 'learned:node:worker_threads_leak',
    slot_type: 'SINGLE_VALUED',
    value: 'terminate before exit',
    authority: Authority.INFERRED,
  });
  assert.strictEqual(res2c.ok, true, 'learned:* debe permitir incorporar nuevas hojas sin intervencion humana');

  // 3. Con autoridad humana (USER_EXPLICIT = 100), se acepta legítimamente (ej: via CLI 'canon learn')
  const res3 = await assertCase.execute({
    entity_key: 'convention:git:branch_format',
    slot_type: 'SINGLE_VALUED',
    value: 'feat/*',
    authority: Authority.USER_EXPLICIT,
  });
  assert.strictEqual(res3.ok, true);
});

test('Use Case: Desafio de menor autoridad genera conflicto sin perder señal', async () => {
  const store = new InMemoryEventStore();
  const assertCase = new AssertFactUseCase(store);
  const queryCase = new QueryActiveStateUseCase(store);

  // Hecho de autoridad alta (100)
  await assertCase.execute({
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'uuidv4',
    authority: Authority.USER_EXPLICIT,
  });

  // El agente deduce ULID (autoridad 40)
  const resDispute = await assertCase.execute({
    entity_key: 'db:pk_format',
    slot_type: 'SINGLE_VALUED',
    value: 'ulid',
    authority: Authority.INFERRED,
  });
  assert.strictEqual(resDispute.ok, true);

  // La consulta de estado activo debe reportar el hecho original y el conflicto de desafio
  const activeState = await queryCase.execute({ anchor: 'db:pk_format' });
  assert.strictEqual(activeState.facts.length, 1);
  assert.strictEqual(activeState.facts[0].value, 'uuidv4');
  assert.strictEqual(activeState.conflicts.length, 1);
  assert.match(activeState.conflicts[0].reason, /Desafío/);
  assert.match(activeState.formattedContext, /EN DISPUTA/);
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

test('CLI: canon register actualiza canon_policy.yaml sin ReferenceError', async () => {
  const tmpSubdir = join(process.cwd(), '.tmp_test_reg_' + Date.now());
  mkdirSync(join(tmpSubdir, '.canon'), { recursive: true });
  try {
    await runCli([
      'node',
      'canon_cli.ts',
      'register',
      'observability:*',
      '--policy',
      'interrupt',
      '--interactive-confirmed',
      '--dir',
      tmpSubdir,
    ]);

    const policyFile = join(tmpSubdir, 'canon_policy.yaml');
    assert.strictEqual(existsSync(policyFile), true);
    const content = readFileSync(policyFile, 'utf8');
    assert.match(content, /"observability:\*": "interrupt"/);
  } finally {
    rmSync(tmpSubdir, { recursive: true, force: true });
  }
});
