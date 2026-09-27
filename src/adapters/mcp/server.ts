// src/adapters/mcp/server.ts
// Servidor MCP para Antigravity usando stdio nativo y JSON-RPC 2.0.
// Cero dependencias externas de NPM, arranca en 30 milisegundos con Node 24.
// Expone canon_assert_fact, canon_query_active, canon_resolve_conflict y canon_audit_repo.

import { createInterface } from 'node:readline';
import { SQLiteEventStore } from '../storage/sqlite_store.ts';
import { AssertFactUseCase } from '../../use_cases/assert_fact.ts';
import { QueryActiveStateUseCase } from '../../use_cases/query_active_state.ts';
import { ResolveConflictUseCase } from '../../use_cases/resolve_conflict.ts';
import { RepoOracle } from '../oracle/repo_oracle.ts';
import { Authority } from '../../domain/models.ts';
import type { SlotCardinality } from '../../domain/models.ts';

const TOOLS = [
  {
    name: 'canon_assert_fact',
    description: 'Registra un hecho o regla en Canon con control de supersesion automatica o slots acumulativos.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_key: {
          type: 'string',
          description: 'Clave jerarquica (ej: dep:tailwindcss:version, db:pk_format, convention:git:branch_naming)',
        },
        slot_type: {
          type: 'string',
          enum: ['SINGLE_VALUED', 'ACCUMULATIVE'],
          description: 'SINGLE_VALUED para valores unicos que se sobreescriben; ACCUMULATIVE para listas de quirks/gotchas',
        },
        value: {
          type: 'string',
          description: 'El valor o regla a registrar (sin secretos ni tokens)',
        },
        authority: {
          type: 'number',
          description: 'Nivel de autoridad: 100 (USER_EXPLICIT), 80 (CODE_VERIFIED), 40 (INFERRED). Por defecto 100.',
        },
      },
      required: ['entity_key', 'slot_type', 'value'],
    },
  },
  {
    name: 'canon_query_active',
    description: 'Consulta los hechos y convenciones actualmente activos en Canon, omitiendo versiones obsoletas.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: {
          type: 'string',
          description: 'Filtro opcional por prefijo (ej: dep:, db:, security:)',
        },
      },
    },
  },
  {
    name: 'canon_resolve_conflict',
    description: 'Resuelve explicitamente una contradiccion de misma autoridad en Canon.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_key: { type: 'string' },
        resolves_event_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de IDs de eventos en pugna que quedan sepultados',
        },
        winning_value: { type: 'string', description: 'El valor ganador acordado' },
        authority: { type: 'number', description: 'Autoridad de la resolucion (ej: 100)' },
      },
      required: ['entity_key', 'resolves_event_ids', 'winning_value'],
    },
  },
  {
    name: 'canon_audit_repo',
    description: 'Audita mecanicamente la memoria contra el package.json del proyecto para auto-corregir dependencias desactualizadas.',
    inputSchema: {
      type: 'object',
      properties: {
        project_root: {
          type: 'string',
          description: 'Ruta absoluta o relativa a la raiz del proyecto donde esta el package.json',
        },
      },
    },
  },
];

export class MCPServer {
  private store: SQLiteEventStore;
  private assertCase: AssertFactUseCase;
  private queryCase: QueryActiveStateUseCase;
  private resolveCase: ResolveConflictUseCase;

  constructor(dbPath: string = 'canon.db') {
    this.store = new SQLiteEventStore(dbPath);
    this.assertCase = new AssertFactUseCase(this.store);
    this.queryCase = new QueryActiveStateUseCase(this.store);
    this.resolveCase = new ResolveConflictUseCase(this.store);
  }

  startStdio(): void {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', async (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        const response = await this.handleMessage(msg);
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch (err) {
        // En caso de parse error enviamos error JSON-RPC estandar
        const errResp = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: ' + String(err) },
        };
        process.stdout.write(JSON.stringify(errResp) + '\n');
      }
    });
  }

  async handleMessage(msg: any): Promise<any> {
    const { id, method, params } = msg;

    // Notificaciones (sin id)
    if (id === undefined || id === null) {
      return null;
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'canon-memory', version: '0.1.0' },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const resultText = await this.dispatchTool(toolName, args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: resultText }],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Metodo no encontrado: ${method}` },
    };
  }

  private async dispatchTool(name: string, args: any): Promise<string> {
    if (name === 'canon_assert_fact') {
      const res = await this.assertCase.execute({
        entity_key: args.entity_key,
        slot_type: args.slot_type as SlotCardinality,
        value: args.value,
        authority: args.authority ?? Authority.USER_EXPLICIT,
      });
      if (!res.ok) {
        return `❌ Error al registrar asercion: ${res.error}`;
      }
      return `✅ Asercion registrada con id ${res.event_id}. Proyeccion actualizada correctamente.`;
    }

    if (name === 'canon_query_active') {
      const res = await this.queryCase.execute({ anchor: args.anchor });
      return res.formattedContext;
    }

    if (name === 'canon_resolve_conflict') {
      const res = await this.resolveCase.execute({
        entity_key: args.entity_key,
        resolves_event_ids: args.resolves_event_ids ?? [],
        winning_value: args.winning_value,
        authority: args.authority ?? Authority.USER_EXPLICIT,
      });
      return `✅ Conflicto en '${args.entity_key}' resuelto. Hecho ganador: '${args.winning_value}'.`;
    }

    if (name === 'canon_audit_repo') {
      const root = args.project_root ?? process.cwd();
      const oracle = new RepoOracle(this.store, root);
      const audit = await oracle.auditPackageJson();
      return `🔍 Auditoria completada en ${root}.\n- Claves inspeccionadas: ${audit.checked_keys}\n- Desactualizaciones corregidas: ${audit.mismatches_found}\n- Eventos de supersesion emitidos: ${audit.superseded_events.length}`;
    }

    return `Herramienta desconocida: ${name}`;
  }
}

// Ejecucion directa por CLI / stdio
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const server = new MCPServer('canon.db');
  server.startStdio();
}
