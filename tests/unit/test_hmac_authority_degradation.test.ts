// tests/unit/test_hmac_authority_degradation.test.ts
// Test de seguridad contra inyeccion y manipulacion manual de archivos:
// Valida que cualquier evento con autoridad > 40 sin firma HMAC valida sea degradado a 40.

import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HybridEventStore } from '../../src/adapters/storage/hybrid_store.ts';
import { signEvent } from '../../src/adapters/crypto/signer.ts';
import { Authority } from '../../src/domain/models.ts';
import type { AssertEvent } from '../../src/domain/models.ts';
import { fold } from '../../src/domain/fold.ts';
import { verifyEventSignature } from '../../src/adapters/crypto/signer.ts';

test('Seguridad HMAC: Linea pegada a mano en events.jsonl con autoridad 100 sin firma se degrada a 40', async () => {
  const tmpCanonDir = mkdtempSync(join(tmpdir(), 'canon-test-tamper-'));
  let store: HybridEventStore | undefined;
  try {
    const jsonlPath = join(tmpCanonDir, 'events.jsonl');

    // Simular un agente o inyeccion escribiendo una linea directamente en disco
    const injectedLine = JSON.stringify({
      id: 'evt_fake_admin',
      schema_version: 1,
      entity_key: 'convention:code:indent',
      logical_ts: 1,
      slot_type: 'SINGLE_VALUED',
      value: 'tabs',
      authority: 100, // Pretende ser USER_EXPLICIT
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    }) + '\n';

    writeFileSync(jsonlPath, injectedLine, 'utf8');

    // Levantamos el store
    store = new HybridEventStore(tmpCanonDir);
    const events = await store.getEvents('convention:code:indent');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(
      events[0].authority,
      40,
      'El evento inyectado sin firma debe haber sido degradado a INFERRED (40) en SQLite cache'
    );

    // Verificamos que el fold puro con verificador tambien lo degrade
    const projection = fold(events, undefined, (e) => verifyEventSignature(e));
    const active = projection.active_facts.get('convention:code:indent');
    assert.ok(active);
    assert.strictEqual(active[0].authority, 40, 'El hecho activo debe tener autoridad 40');
  } finally {
    store?.close();
    rmSync(tmpCanonDir, { recursive: true, force: true });
  }
});

test('Seguridad HMAC: Evento firmado legitimamente por canal confiable mantiene autoridad 100', async () => {
  const tmpCanonDir = mkdtempSync(join(tmpdir(), 'canon-test-signed-'));
  let store: HybridEventStore | undefined;
  try {
    store = new HybridEventStore(tmpCanonDir);

    const validEvent: AssertEvent = {
      id: 'evt_legit_user',
      schema_version: 1,
      entity_key: 'convention:git:branch_naming',
      logical_ts: 1,
      slot_type: 'SINGLE_VALUED',
      value: 'main',
      authority: Authority.USER_EXPLICIT, // 100
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };
    validEvent.signature = signEvent(validEvent);

    await store.append(validEvent);

    const events = await store.getEvents('convention:git:branch_naming');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(
      events[0].authority,
      100,
      'El evento legitimamente firmado debe conservar su autoridad 100'
    );

    const projection = fold(events, undefined, (e) => verifyEventSignature(e));
    const active = projection.active_facts.get('convention:git:branch_naming');
    assert.ok(active);
    assert.strictEqual(active[0].authority, 100);
  } finally {
    store?.close();
    rmSync(tmpCanonDir, { recursive: true, force: true });
  }
});

test('Seguridad HMAC: Evento con payload alterado (tampering) invalida la firma y se degrada a 40', async () => {
  const tmpCanonDir = mkdtempSync(join(tmpdir(), 'canon-test-tampered-payload-'));
  let store: HybridEventStore | undefined;
  try {
    const jsonlPath = join(tmpCanonDir, 'events.jsonl');

    const originalEvent: AssertEvent = {
      id: 'evt_tampered',
      schema_version: 1,
      entity_key: 'db:pk_format',
      logical_ts: 1,
      slot_type: 'SINGLE_VALUED',
      value: 'uuidv7',
      authority: Authority.USER_EXPLICIT,
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };
    const signature = signEvent(originalEvent);

    // Alteramos el valor en el JSONL pero dejamos la firma vieja
    const tamperedLine = JSON.stringify({
      ...originalEvent,
      value: 'ulid_hacked',
      signature,
    }) + '\n';

    writeFileSync(jsonlPath, tamperedLine, 'utf8');

    store = new HybridEventStore(tmpCanonDir);
    const events = await store.getEvents('db:pk_format');

    assert.strictEqual(events.length, 1);
    assert.strictEqual(
      events[0].authority,
      40,
      'Al no coincidir la firma con el contenido alterado, debe degradarse a 40'
    );
  } finally {
    store?.close();
    rmSync(tmpCanonDir, { recursive: true, force: true });
  }
});
