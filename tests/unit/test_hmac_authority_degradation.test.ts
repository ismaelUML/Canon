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

test('Seguridad HMAC: Verificacion campo por campo de la firma (id, logical_ts, supersedes_event_id, entity_key, value, schema_version, created_at)', () => {
  const baseEvent: AssertEvent = {
    id: 'evt_field_test',
    schema_version: 1,
    entity_key: 'convention:git:branch_naming',
    logical_ts: 42,
    slot_type: 'SINGLE_VALUED',
    value: 'feature/*',
    authority: Authority.USER_EXPLICIT,
    supersedes_event_id: 'evt_prev_123',
    created_at: '2026-09-28T12:00:00.000Z',
    type: 'ASSERT',
  };

  const validSignature = signEvent(baseEvent);
  const signedBase = { ...baseEvent, signature: validSignature };

  // 1. Valida que el original es 100% valido
  assert.strictEqual(verifyEventSignature(signedBase), true, 'El evento intacto debe ser valido');

  // 2. Tampering campo por campo:
  // a) id
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, id: 'evt_tampered_id' }),
    false,
    'Alterar id debe invalidar la firma'
  );

  // b) logical_ts (previene ataque de mover evento al final del log)
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, logical_ts: 9999 }),
    false,
    'Alterar logical_ts debe invalidar la firma'
  );

  // c) supersedes_event_id
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, supersedes_event_id: 'evt_injected_target' }),
    false,
    'Alterar supersedes_event_id debe invalidar la firma'
  );

  // d) entity_key
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, entity_key: 'security:auth_mode' }),
    false,
    'Alterar entity_key debe invalidar la firma'
  );

  // e) value
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, value: 'malicious_value' }),
    false,
    'Alterar value debe invalidar la firma'
  );

  // f) schema_version
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, schema_version: 2 }),
    false,
    'Alterar schema_version debe invalidar la firma'
  );

  // g) created_at
  assert.strictEqual(
    verifyEventSignature({ ...signedBase, created_at: '2026-09-28T12:00:01.000Z' }),
    false,
    'Alterar created_at debe invalidar la firma'
  );
});

test('Seguridad HMAC: Ataque de resurreccion manipulando logical_ts se degrada a 40 y el hecho superseded no resucita', async () => {
  const tmpCanonDir = mkdtempSync(join(tmpdir(), 'canon-resurrect-'));
  let store: HybridEventStore | undefined;
  try {
    const jsonlPath = join(tmpCanonDir, 'events.jsonl');

    // 1. Hecho antiguo original (logical_ts: 1)
    const oldEvent: AssertEvent = {
      id: 'evt_old_decision',
      schema_version: 1,
      entity_key: 'convention:git:branch_naming',
      logical_ts: 1,
      slot_type: 'SINGLE_VALUED',
      value: 'v1_old',
      authority: Authority.USER_EXPLICIT,
      created_at: '2026-01-01T00:00:00.000Z',
      type: 'ASSERT',
    };
    oldEvent.signature = signEvent(oldEvent);

    // 2. Hecho nuevo que supersedio al antiguo (logical_ts: 2)
    const newEvent: AssertEvent = {
      id: 'evt_new_decision',
      schema_version: 1,
      entity_key: 'convention:git:branch_naming',
      logical_ts: 2,
      slot_type: 'SINGLE_VALUED',
      value: 'v2_new',
      authority: Authority.USER_EXPLICIT,
      supersedes_event_id: 'evt_old_decision',
      created_at: '2026-01-02T00:00:00.000Z',
      type: 'ASSERT',
    };
    newEvent.signature = signEvent(newEvent);

    // 3. Atacante intenta mover el evento viejo al final del log cambiando su logical_ts a 999 para que gane por LWW
    const resurrectedTampered = {
      ...oldEvent,
      logical_ts: 999, // Alterado sin clave
    };

    // Escribimos en el archivo: oldEvent, newEvent, y luego el oldEvent manipulado
    const content = [
      JSON.stringify(oldEvent),
      JSON.stringify(newEvent),
      JSON.stringify(resurrectedTampered),
    ].join('\n') + '\n';

    writeFileSync(jsonlPath, content, 'utf8');

    store = new HybridEventStore(tmpCanonDir);
    const events = await store.getEvents('convention:git:branch_naming');

    // Al tener el logical_ts alterado, el evento resucitado se degrada a 40.
    // El fold determina que 'v2_new' (con autoridad 100 y firma valida) permanece como activo.
    const projection = fold(events, undefined, (e) => verifyEventSignature(e));
    const active = projection.active_facts.get('convention:git:branch_naming');
    assert.strictEqual(active?.length, 1);
    assert.strictEqual(
      active![0].value,
      'v2_new',
      'El evento manipulado no debe resucitar porque su firma quedo invalida y su autoridad degradada'
    );
    assert.strictEqual(active![0].authority, 100);
  } finally {
    store?.close();
    rmSync(tmpCanonDir, { recursive: true, force: true });
  }
});

test('Seguridad Fold: Deduplicacion estricta por ID previene reproduccion por copiado de lineas firmadas en ACCUMULATIVE', () => {
  const legitEvent: AssertEvent = {
    id: 'evt_quirk_1',
    schema_version: 1,
    entity_key: 'convention:quirks',
    logical_ts: 1,
    slot_type: 'ACCUMULATIVE',
    value: 'quirk_detail',
    authority: Authority.USER_EXPLICIT,
    created_at: '2026-09-28T12:00:00.000Z',
    type: 'ASSERT',
  };
  legitEvent.signature = signEvent(legitEvent);

  // Un agente copia y pega la misma linea firmada 5 veces en events.jsonl
  const duplicatedLog = [legitEvent, legitEvent, legitEvent, legitEvent, legitEvent];

  const projection = fold(duplicatedLog, undefined, (e) => verifyEventSignature(e));
  const quirks = projection.active_facts.get('convention:quirks');

  assert.strictEqual(quirks?.length, 1, 'Copiar la misma linea firmada N veces no debe multiplicar los hechos activos');
  assert.strictEqual(quirks![0].id, 'evt_quirk_1');
});
