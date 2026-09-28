// src/adapters/mcp/server.ts
// Servidor MCP para Antigravity usando stdio nativo y JSON-RPC 2.0.
// Cero dependencias externas de NPM, arranca en 30 milisegundos con Node 24.
// Expone canon_assert_fact, canon_query_active, canon_resolve_conflict y canon_audit_repo.

import { createInterface } from 'node:readline';
import { resolveProjectRoot } from '../resolver/path_resolver.ts';
import { HybridEventStore } from '../storage/hybrid_store.ts';
import { AssertFactUseCase } from '../../use_cases/assert_fact.ts';
import { QueryActiveStateUseCase } from '../../use_cases/query_active_state.ts';
import { ResolveConflictUseCase } from '../../use_cases/resolve_conflict.ts';
import { RepoOracle } from '../oracle/repo_oracle.ts';
import { Authority } from '../../domain/models.ts';
import type { SlotCardinality } from '../../domain/models.ts';

const TOOLS = [
  {
    name: 'canon_assert_fact',
    description: 'Registra un hecho o regla en Canon con control de supersesion automatica o slots acumulativos en el proyecto activo.',
    inputSchema: {
      type: 'object',
      properties: {
        context_path: {
          type: 'string',
          description: 'Ruta del archivo o carpeta activa para resolver el proyecto o monorepo (busca hacia arriba con techo en .git)',
        },
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
        supersedes_event_id: {
          type: 'string',
          description: 'ID opcional del evento activo que se busca actualizar',
        },
        new_leaf: {
          type: 'boolean',
          description: 'Establecer en true si se desea crear una nueva hoja bajo un subsistema conocido',
        },
      },
      required: ['context_path', 'entity_key', 'slot_type', 'value'],
    },
  },
  {
    name: 'canon_query_active',
    description: 'Consulta los hechos y convenciones actualmente activos en Canon para el proyecto activo.',
    inputSchema: {
      type: 'object',
      properties: {
        context_path: {
          type: 'string',
          description: 'Ruta del archivo o carpeta activa para resolver el proyecto o monorepo',
        },
        anchor: {
          type: 'string',
          description: 'Filtro opcional por prefijo (ej: dep:, db:, security:)',
        },
      },
      required: ['context_path'],
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
  private stores: Map<string, HybridEventStore> = new Map();
  // Rate limiter por ventana temporal como stopgap anti-loop
  private rateLimitMap: Map<string, number[]> = new Map();
  private maxAssertionsPerWindow: number = 10;
  private rateLimitWindowMs: number = 60_000;

  constructor() {}

  getStore(contextPath?: string): { store: HybridEventStore; rootDir: string } {
    const targetPath = contextPath ?? process.cwd();
    const resolved = resolveProjectRoot(targetPath);
    let store = this.stores.get(resolved.canonDir);
    if (!store) {
      store = new HybridEventStore(resolved.canonDir);
      this.stores.set(resolved.canonDir, store);
    }
    return { store, rootDir: resolved.rootDir };
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
    const { store, rootDir } = this.getStore(args.context_path);
    const assertCase = new AssertFactUseCase(store);
    const queryCase = new QueryActiveStateUseCase(store);
    const resolveCase = new ResolveConflictUseCase(store);

    if (name === 'canon_assert_fact') {
      const now = Date.now();
      const timestamps = (this.rateLimitMap.get(rootDir) ?? []).filter(
        (t) => now - t < this.rateLimitWindowMs
      );
      if (timestamps.length >= this.maxAssertionsPerWindow) {
        return `❌ Rate limit temporal alcanzado (${this.maxAssertionsPerWindow} aserciones por minuto para este proyecto). Esperá unos segundos antes de reintentar. (Nota: stopgap temporal; solución definitiva requiere turn_id del cliente).`;
      }
      timestamps.push(now);
      this.rateLimitMap.set(rootDir, timestamps);

      const res = await assertCase.execute({
        entity_key: args.entity_key,
        slot_type: args.slot_type as SlotCardinality,
        value: args.value,
        authority: Authority.INFERRED, // Forzado por canal: todo lo que entra por MCP es INFERRED (40)
        supersedes_event_id: args.supersedes_event_id,
        new_leaf: args.new_leaf,
      });
      if (!res.ok) {
        return `❌ Error al registrar asercion: ${res.error}`;
      }
      return `✅ Asercion registrada con id ${res.event_id} en ${rootDir}. Proyeccion actualizada.`;
    }

    if (name === 'canon_query_active') {
      const res = await queryCase.execute({ anchor: args.anchor });
      return `[Proyecto: ${rootDir}]\n` + res.formattedContext;
    }

    if (name === 'canon_resolve_conflict') {
      const res = await resolveCase.execute({
        entity_key: args.entity_key,
        resolves_event_ids: args.resolves_event_ids ?? [],
        winning_value: args.winning_value,
        authority: args.authority ?? Authority.USER_EXPLICIT,
      });
      return `✅ Conflicto en '${args.entity_key}' resuelto en ${rootDir}. Hecho ganador: '${args.winning_value}'.`;
    }

    if (name === 'canon_audit_repo') {
      const oracle = new RepoOracle(store, rootDir);
      const audit = await oracle.auditPackageJson();
      return `🔍 Auditoria completada en ${rootDir}.\n- Claves inspeccionadas: ${audit.checked_keys}\n- Desactualizaciones corregidas: ${audit.mismatches_found}\n- Eventos de supersesion emitidos: ${audit.superseded_events.length}`;
    }

    return `Herramienta desconocida: ${name}`;
  }
}

// Ejecucion directa por CLI / stdio
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const server = new MCPServer();
  server.startStdio();
}
