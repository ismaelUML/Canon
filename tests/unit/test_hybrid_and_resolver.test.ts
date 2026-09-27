// tests/unit/test_hybrid_and_resolver.test.ts
// Tests unitarios para PathResolver (techo en .git) y HybridEventStore (lock atomico, SHA-256 y reloj logico).

import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectRoot } from '../../src/adapters/resolver/path_resolver.ts';
import { HybridEventStore } from '../../src/adapters/storage/hybrid_store.ts';
import { fold } from '../../src/domain/fold.ts';
import { Authority } from '../../src/domain/models.ts';
import type { AssertEvent, SupersedeEvent } from '../../src/domain/models.ts';

test('PathResolver: Aisla subproyectos en monorepos y frena en techo duro .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-resolver-test-'));

  // Estructura:
  // /repo (.git)
  //   ├── backend (go.mod)
  //   │     └── src/controllers/auth.go
  //   └── frontend (package.json)
  const gitDir = join(root, '.git');
  const backendDir = join(root, 'backend');
  const backendSrc = join(backendDir, 'src', 'controllers');
  const frontendDir = join(root, 'frontend');

  mkdirSync(gitDir);
  mkdirSync(backendSrc, { recursive: true });
  mkdirSync(frontendDir);
  writeFileSync(join(backendDir, 'go.mod'), 'module backend');
  writeFileSync(join(frontendDir, 'package.json'), '{"name": "frontend"}');

  // 1. Desde backend/src/controllers/auth.go debe resolver a backend/
  const resBackend = resolveProjectRoot(join(backendSrc, 'auth.go'));
  assert.strictEqual(resBackend.rootDir, backendDir);
  assert.strictEqual(resBackend.canonDir, join(backendDir, '.canon'));

  // 2. Desde frontend debe resolver a frontend/
  const resFrontend = resolveProjectRoot(join(frontendDir, 'index.ts'));
  assert.strictEqual(resFrontend.rootDir, frontendDir);
  assert.strictEqual(resFrontend.canonDir, join(frontendDir, '.canon'));

  // 3. Si no hay boundary intermedio, el techo duro es .git/
  const looseDir = join(root, 'scripts');
  mkdirSync(looseDir);
  const resLoose = resolveProjectRoot(join(looseDir, 'deploy.sh'));
  assert.strictEqual(resLoose.rootDir, root, 'Debe frenar en la raiz del repo Git');

  rmSync(root, { recursive: true, force: true });
});

test('HybridStore: Concurrencia real bajo lock atomico genera logical_ts secuencial sin corrupcion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-lock-test-'));
  const canonDir = join(root, '.canon');
  const store = new HybridEventStore(canonDir);

  // Disparamos 10 escrituras concurrentes simultaneas
  const promises = Array.from({ length: 10 }).map((_, i) => {
    const evt: AssertEvent = {
      id: `evt_concurrent_${i}`,
      entity_key: `test:item:${i}`,
      logical_ts: 0, // El store debe asignar max(disco) + 1 secuencialmente
      slot_type: 'SINGLE_VALUED',
      value: `val_${i}`,
      authority: Authority.USER_EXPLICIT,
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };
    return store.append(evt);
  });

  await Promise.all(promises);

  // 1. Validar que events.jsonl tiene exactamente 10 lineas validas
  const jsonlPath = join(canonDir, 'events.jsonl');
  const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 10);

  // 2. Validar que cada linea es JSON valido y los logical_ts van del 1 al 10
  const parsed = lines.map((l) => JSON.parse(l));
  const timestamps = parsed.map((e) => e.logical_ts).sort((a, b) => a - b);
  assert.deepStrictEqual(timestamps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('HybridStore: Invalidacion por SHA-256 detecta cambios externos (ej: git pull)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canon-sha-test-'));
  const canonDir = join(root, '.canon');
  const store = new HybridEventStore(canonDir);

  await store.append({
    id: 'evt_1',
    entity_key: 'config:port',
    logical_ts: 0,
    slot_type: 'SINGLE_VALUED',
    value: '3000',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-01T00:00:00Z',
    type: 'ASSERT',
  });

  // Simulamos un git pull que agrega una linea externamente al JSONL
  const jsonlPath = join(canonDir, 'events.jsonl');
  const externalEvent = {
    id: 'evt_pull_2',
    entity_key: 'config:port',
    logical_ts: 2,
    slot_type: 'SINGLE_VALUED',
    value: '4000',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-02T00:00:00Z',
    type: 'ASSERT',
  };
  writeFileSync(jsonlPath, readFileSync(jsonlPath, 'utf8') + JSON.stringify(externalEvent) + '\n');

  // Al consultar, syncCache detecta el hash SHA-256 cambiado y actualiza
  const all = await store.getAllEvents();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[1].value, '4000');

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('Fold: Determinismo frente a lineas desordenadas de un merge de Git', () => {
  // Simulamos que Git 3-way merge concatena el SUPERSEDE antes del ASSERT
  const evtAssert: AssertEvent = {
    id: 'evt_base',
    entity_key: 'dep:bundler',
    logical_ts: 1, // Ocurrio primero logicamente
    slot_type: 'SINGLE_VALUED',
    value: 'webpack',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-01T10:00:00Z',
    type: 'ASSERT',
  };

  const evtSupersede: SupersedeEvent = {
    id: 'evt_next',
    entity_key: 'dep:bundler',
    logical_ts: 2, // Ocurrio despues logicamente
    supersedes_event_id: 'evt_base',
    new_value: 'vite',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-01-01T10:05:00Z',
    type: 'SUPERSEDE',
  };

  // En el archivo quedaron al reves por el algoritmo de diff de Git: [SUPERSEDE, ASSERT]
  const scrambledInFile = [evtSupersede, evtAssert];

  const projection = fold(scrambledInFile);
  const active = projection.active_facts.get('dep:bundler');

  assert.ok(active);
  assert.strictEqual(
    active[0].value,
    'vite',
    'El fold debe ordenar por logical_ts; Vite debe ganar sin importar el orden en el archivo'
  );
  assert.ok(projection.superseded_event_ids.has('evt_base'));
});
