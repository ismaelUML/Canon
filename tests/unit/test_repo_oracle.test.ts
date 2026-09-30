// tests/unit/test_repo_oracle.test.ts
// Test unitario del Oraculo Mecanico: autocorreccion de Canon contra package.json.

import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventStore } from '../../packages/canon_infrastructure/src/storage/in_memory.ts';
import { RepoOracle } from '../../packages/canon_application/src/oracle/repo_oracle.ts';
import { fold } from '../../packages/canon_domain/src/fold.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';
import type { AssertEvent } from '../../packages/canon_domain/src/models.ts';

test('RepoOracle: Detecta version desactualizada en memoria y emite supersesion automatica', async () => {
  const store = new InMemoryEventStore();

  // Creamos un directorio temporal con un package.json real
  const tempDir = mkdtempSync(join(tmpdir(), 'canon-oracle-test-'));
  const pkgContent = {
    name: 'test-app',
    dependencies: {
      tailwindcss: '^4.0.0',
    },
  };
  writeFileSync(join(tempDir, 'package.json'), JSON.stringify(pkgContent, null, 2));

  // En Canon tenemos registrado un hecho viejo (Tailwind v3.4.0)
  const oldFact: AssertEvent = {
    id: 'evt_old_tw',
    entity_key: 'dep:tailwindcss:version',
    slot_type: 'SINGLE_VALUED',
    value: '^3.4.0',
    authority: Authority.INFERRED,
    created_at: '2026-01-01T00:00:00Z',
    type: 'ASSERT',
  };
  await store.append(oldFact);

  // Ejecutamos la auditoria mecanica del oraculo
  const oracle = new RepoOracle(store, tempDir);
  const auditResult = await oracle.auditPackageJson();

  assert.strictEqual(auditResult.mismatches_found, 1);
  assert.strictEqual(auditResult.superseded_events.length, 1);

  // Verificamos que la proyeccion activa ahora refleje la realidad del disco
  const allEvents = await store.getAllEvents();
  const projection = fold(allEvents);

  const active = projection.active_facts.get('dep:tailwindcss:version');
  assert.ok(active);
  assert.strictEqual(active[0].value, '^4.0.0');
  assert.strictEqual(active[0].authority, Authority.REPO_ORACLE);
  assert.ok(projection.superseded_event_ids.has('evt_old_tw'));

  // Limpieza
  rmSync(tempDir, { recursive: true, force: true });
});
