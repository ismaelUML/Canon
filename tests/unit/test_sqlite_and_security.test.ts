// tests/unit/test_sqlite_and_security.test.ts
// Tests unitarios para el adaptador SQLite nativo y el validador defensivo de secretos.

import test from 'node:test';
import assert from 'node:assert';
import { SQLiteEventStore } from '../../packages/canon_infrastructure/src/storage/sqlite_store.ts';
import { HybridEventStore, assertSafeChildPath, validateDatabasePath } from '../../packages/canon_infrastructure/src/storage/hybrid_store.ts';
import { validateAssertionSecurity } from '../../packages/canon_domain/src/security.ts';
import { fold } from '../../packages/canon_domain/src/fold.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';
import type { AssertEvent, SupersedeEvent, ResolveConflictEvent } from '../../packages/canon_domain/src/models.ts';

test('Seguridad: Rechaza credenciales y secretos en aserciones', () => {
  const bad1 = validateAssertionSecurity('Use api key sk-12345678901234567890 for auth');
  assert.strictEqual(bad1.allowed, false);

  const bad2 = validateAssertionSecurity('DB string is postgres://admin:secret123@localhost:5432/app');
  assert.strictEqual(bad2.allowed, false);

  const bad3 = validateAssertionSecurity('-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA...');
  assert.strictEqual(bad3.allowed, false);

  const good = validateAssertionSecurity('Use Bun 1.1 with Tailwind CSS v4 in src/styles/main.css');
  assert.strictEqual(good.allowed, true);
});

test('SQLite Store: Persistencia y reconstruccion de proyeccion exacta', async () => {
  // Base de datos en memoria para no dejar mugre en disco durante el test
  const store = new SQLiteEventStore(':memory:');

  const evt1: AssertEvent = {
    id: 'evt_sql_1',
    entity_key: 'dep:package_manager',
    slot_type: 'SINGLE_VALUED',
    value: 'pnpm',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_init',
    created_at: '2026-01-01T00:00:00Z',
    type: 'ASSERT',
  };

  const evt2: SupersedeEvent = {
    id: 'evt_sql_2',
    entity_key: 'dep:package_manager',
    supersedes_event_id: 'evt_sql_1',
    new_value: 'bun',
    authority: Authority.USER_EXPLICIT,
    source_session_id: 'session_update',
    created_at: '2026-01-02T00:00:00Z',
    type: 'SUPERSEDE',
  };

  await store.append(evt1);
  await store.append(evt2);

  // Consulta por clave
  const keyEvents = await store.getEvents('dep:package_manager');
  assert.strictEqual(keyEvents.length, 2);

  // Proyeccion sobre eventos leidos de SQLite
  const allEvents = await store.getAllEvents();
  const projection = fold(allEvents);

  const active = projection.active_facts.get('dep:package_manager');
  assert.ok(active);
  assert.strictEqual(active[0].value, 'bun');
  assert.ok(projection.superseded_event_ids.has('evt_sql_1'));

  store.close();
});

test('Seguridad: assertSafeChildPath y HybridStore rechazan intentos de path traversal y null bytes', () => {
  assert.throws(() => {
    assertSafeChildPath('C:\\some\\project\\.canon', '../secrets/events.jsonl');
  }, /Path traversal/);

  assert.throws(() => {
    assertSafeChildPath('C:\\some\\project\\.canon\0malicious', 'events.jsonl');
  }, /Path traversal/);

  assert.throws(() => {
    new HybridEventStore('C:\\some\\project\\.canon\0malicious');
  }, /Path traversal/);
});

test('Seguridad: validateDatabasePath rechaza inyeccion de connection strings y URIs en SQLite', () => {
  assert.throws(() => {
    validateDatabasePath('file:cache.db?mode=ro');
  }, /connection string injection/);

  assert.throws(() => {
    validateDatabasePath('cache.db?cache=shared');
  }, /connection string injection/);

  assert.throws(() => {
    validateDatabasePath('malicious_file.sql');
  }, /connection string injection/);

  assert.throws(() => {
    validateDatabasePath('cache.db\0evil');
  }, /null byte detected/);

  assert.strictEqual(validateDatabasePath(':memory:'), ':memory:');
});
