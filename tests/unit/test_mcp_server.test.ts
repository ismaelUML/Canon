// tests/unit/test_mcp_server.test.ts
// Test unitario del adaptador MCP: valida el protocolo JSON-RPC 2.0 y el despacho de tools.

import test from 'node:test';
import assert from 'node:assert';
import { MCPServer } from '../../src/adapters/mcp/server.ts';
import { Authority } from '../../src/domain/models.ts';
import type { AssertEvent } from '../../src/domain/models.ts';
import { signEvent } from '../../src/adapters/crypto/signer.ts';
import { fold } from '../../src/domain/fold.ts';

test('MCP Server: Handshake initialize y tools/list cumplen con JSON-RPC 2.0', async () => {
  const server = new MCPServer(':memory:');

  // 1. Initialize
  const initResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  assert.strictEqual(initResp.id, 1);
  assert.strictEqual(initResp.result.serverInfo.name, 'canon-memory');

  // 2. Tools list
  const listResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert.strictEqual(listResp.id, 2);
  const toolNames = listResp.result.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes('canon_assert_fact'));
  assert.ok(toolNames.includes('canon_query_active'));
  assert.strictEqual(
    toolNames.includes('canon_resolve_conflict'),
    false,
    'canon_resolve_conflict no debe estar expuesto a agentes en tools/list'
  );
  assert.ok(toolNames.includes('canon_audit_repo'));
});

test('MCP Server: tools/call ejecuta aserciones y consultas en vivo', async () => {
  const server = new MCPServer(':memory:');

  // 1. Registramos asercion via MCP
  const assertResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'canon_assert_fact',
      arguments: {
        entity_key: 'convention:git:branch_naming',
        slot_type: 'SINGLE_VALUED',
        value: 'dan/feat-*',
        authority: 100,
      },
    },
  });
  assert.strictEqual(assertResp.id, 10);
  assert.match(assertResp.result.content[0].text, /Asercion registrada con id/);

  // 2. Consultamos estado activo via MCP
  const queryResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'canon_query_active',
      arguments: {},
    },
  });
  assert.strictEqual(queryResp.id, 11);
  assert.match(queryResp.result.content[0].text, /convention:git:branch_naming/);
  assert.match(queryResp.result.content[0].text, /dan\/feat-\*/);
});

test('MCP Server Propiedad: Ninguna llamada por MCP puede producir autoridad mayor a 40', async () => {
  const server = new MCPServer(':memory:');
  const attempts = [100, 999, 80, -1, undefined, null, '100'];

  const testRunId = Date.now().toString(36);
  for (let i = 0; i < attempts.length; i++) {
    const authorityInput = attempts[i];
    const key = `convention:test_prop_${testRunId}_${i}`;

    const resp = await server.handleMessage({
      jsonrpc: '2.0',
      id: 100 + i,
      method: 'tools/call',
      params: {
        name: 'canon_assert_fact',
        arguments: {
          entity_key: key,
          slot_type: 'SINGLE_VALUED',
          value: `val_${i}`,
          authority: authorityInput, // Intento de falsificar o autodeclarar autoridad
          new_leaf: true,
        },
      },
    });

    assert.strictEqual(resp.id, 100 + i);
    assert.match(resp.result.content[0].text, /Asercion registrada con id/);

    const { store } = server.getStore();
    const storedEvents = await store.getEvents(key);
    assert.strictEqual(storedEvents.length, 1);
    assert.strictEqual(
      storedEvents[0].authority,
      40,
      `Para input ${authorityInput}, la autoridad almacenada DEBE ser estrictamente 40 (INFERRED)`
    );
  }
});

test('MCP Server Invariante Fuerte: Ninguna secuencia de llamadas MCP puede cambiar el valor activo de un hecho con autoridad > 40', async () => {
  const server = new MCPServer(':memory:');
  const { store } = server.getStore();

  const key = `convention:git:invariant_test_${Date.now()}`;
  const userFactId = 'evt_user_ground_truth';

  // 1. Hecho legítimo del usuario con autoridad 100 firmado
  const userEvent: AssertEvent = {
    id: userFactId,
    schema_version: 1,
    entity_key: key,
    logical_ts: 1,
    slot_type: 'SINGLE_VALUED',
    value: 'ground_truth_v1',
    authority: Authority.USER_EXPLICIT, // 100
    created_at: new Date().toISOString(),
    type: 'ASSERT',
  };
  userEvent.signature = signEvent(userEvent);
  await store.append(userEvent);

  // 2. Secuencia hostil de llamadas MCP intentando derribar el hecho del usuario:
  // Intento A: Aserción directa con otro valor pretendiendo ser 100
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 501,
    method: 'tools/call',
    params: {
      name: 'canon_assert_fact',
      arguments: {
        entity_key: key,
        slot_type: 'SINGLE_VALUED',
        value: 'hacked_v2',
        authority: 100,
      },
    },
  });

  // Intento B: Intento explícito de superseder el evento del usuario
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 502,
    method: 'tools/call',
    params: {
      name: 'canon_assert_fact',
      arguments: {
        entity_key: key,
        slot_type: 'SINGLE_VALUED',
        value: 'hacked_v3',
        supersedes_event_id: userFactId,
      },
    },
  });

  // Intento C: Intento de llamar a resolve_conflict
  const resolveResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 503,
    method: 'tools/call',
    params: {
      name: 'canon_resolve_conflict',
      arguments: {
        entity_key: key,
        resolves_event_ids: [userFactId],
        winning_value: 'hacked_v4',
        authority: 100,
      },
    },
  });
  assert.match(resolveResp.result.content[0].text, /No autorizado/);

  // 3. Verificamos la verdad activa a través de canon_query_active
  const queryResp = await server.handleMessage({
    jsonrpc: '2.0',
    id: 504,
    method: 'tools/call',
    params: {
      name: 'canon_query_active',
      arguments: { anchor: key },
    },
  });

  const outputText = queryResp.result.content[0].text;
  // El valor activo DEBE permanecer inmutable en 'ground_truth_v1'
  const activeFactsSection = outputText.split('HECHOS ACTIVOS:')[1] ?? '';
  assert.match(activeFactsSection, new RegExp(`\\[${key}\\] = ground_truth_v1`));
  assert.strictEqual(activeFactsSection.includes('hacked_v2'), false);
  assert.strictEqual(activeFactsSection.includes('hacked_v3'), false);
  assert.strictEqual(activeFactsSection.includes('hacked_v4'), false);

  // Verificamos directamente en el store / fold de dominio que el hecho activo es ground_truth_v1
  const allEvents = await store.getAllEvents();
  const projection = fold(allEvents);
  const activeList = projection.active_facts.get(key);
  assert.strictEqual(activeList?.length, 1);
  assert.strictEqual(activeList![0].value, 'ground_truth_v1');
  assert.strictEqual(activeList![0].authority, 100);
});

