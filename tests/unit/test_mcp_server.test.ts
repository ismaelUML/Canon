// tests/unit/test_mcp_server.test.ts
// Test unitario del adaptador MCP: valida el protocolo JSON-RPC 2.0 y el despacho de tools.

import test from 'node:test';
import assert from 'node:assert';
import { MCPServer } from '../../src/adapters/mcp/server.ts';

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
  assert.ok(toolNames.includes('canon_resolve_conflict'));
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
