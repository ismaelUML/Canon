// packages/canon_presentation/src/mcp/server.ts
// Servidor MCP para Antigravity usando stdio nativo y JSON-RPC 2.0.
// Contrapresion acotada (BoundedTaskQueue), politica de desalojo LRU y CC <= 5 por funcion.

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { EventStore, SlotCardinality } from '../../../canon_domain/src/index.ts';
import { Authority } from '../../../canon_domain/src/index.ts';
import { resolveProjectRoot, AssertFactUseCase, QueryActiveStateUseCase, RepoOracle } from '../../../canon_application/src/index.ts';
import { HybridEventStore, InMemoryEventStore } from '../../../canon_infrastructure/src/index.ts';
import { BoundedTaskQueue } from '../concurrency/bounded_queue.ts';

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
        allow_new_leaf: {
          type: 'boolean',
          description: 'Opcional. Si es true, permite crear una nueva propiedad o hoja bajo un subsistema existente sin ser rechazado por sospecha de sinonimia.',
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
  private storeAccessOrder: string[] = []; // Para desalojo LRU
  private maxCachedStores: number = 50;
  private customStore?: EventStore;
  private rateLimitMap: Map<string, number[]> = new Map();
  private maxAssertionsPerWindow: number = 10;
  private rateLimitWindowMs: number = 60_000;
  private taskQueue: BoundedTaskQueue = new BoundedTaskQueue(4, 50);

  constructor(customStoreOrMode?: string | EventStore) {
    if (customStoreOrMode === ':memory:') {
      this.customStore = new InMemoryEventStore();
    } else if (typeof customStoreOrMode === 'object') {
      this.customStore = customStoreOrMode;
    }
  }

  getStore(contextPath?: string): { store: EventStore; rootDir: string } {
    if (this.customStore) {
      return { store: this.customStore, rootDir: ':memory:' };
    }
    const rawTargetPath = contextPath ?? process.cwd();
    const targetPath = resolve(rawTargetPath);
    if (targetPath.includes('\0')) {
      throw new Error('Path traversal detected: invalid path');
    }
    const resolved = resolveProjectRoot(targetPath);
    let store = this.stores.get(resolved.canonDir);
    if (!store) {
      this.evictOldestStoreIfFull();
      store = new HybridEventStore(resolved.canonDir);
      this.stores.set(resolved.canonDir, store);
    }
    this.touchStoreLru(resolved.canonDir);
    return { store, rootDir: resolved.rootDir };
  }

  private touchStoreLru(canonDir: string): void {
    this.storeAccessOrder = this.storeAccessOrder.filter((d) => d !== canonDir);
    this.storeAccessOrder.push(canonDir);
  }

  private evictOldestStoreIfFull(): void {
    if (this.stores.size >= this.maxCachedStores && this.storeAccessOrder.length > 0) {
      const oldest = this.storeAccessOrder.shift();
      if (oldest) {
        const storeToClose = this.stores.get(oldest);
        storeToClose?.close();
        this.stores.delete(oldest);
      }
    }
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
    if (id === undefined || id === null) {
      return null;
    }
    return await this.dispatchRpcMethod(id, method, params);
  }

  private async dispatchRpcMethod(id: any, method: string, params: any): Promise<any> {
    if (method === 'initialize') {
      return this.handleInitialize(id);
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      return await this.handleToolsCall(id, params);
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Metodo no encontrado: ${method}` },
    };
  }

  private handleInitialize(id: any): any {
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

  private async handleToolsCall(id: any, params: any): Promise<any> {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    try {
      const resultText = await this.taskQueue.enqueue(() => this.dispatchTool(toolName, args));
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: resultText }],
        },
      };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: err.code || -32000, message: err.message },
      };
    }
  }

  private checkRateLimit(rootDir: string): boolean {
    const now = Date.now();
    const timestamps = (this.rateLimitMap.get(rootDir) ?? []).filter(
      (t) => now - t < this.rateLimitWindowMs
    );
    if (timestamps.length >= this.maxAssertionsPerWindow) {
      return false;
    }
    timestamps.push(now);
    this.rateLimitMap.set(rootDir, timestamps);
    return true;
  }

  private async dispatchTool(name: string, args: any): Promise<string> {
    const { store, rootDir } = this.getStore(args.context_path);

    if (name === 'canon_assert_fact') {
      return await this.handleAssertTool(args, store, rootDir);
    }
    if (name === 'canon_query_active') {
      return await this.handleQueryTool(args, store, rootDir);
    }
    if (name === 'canon_resolve_conflict') {
      return `❌ No autorizado: Los agentes no tienen permiso para resolver conflictos. La resolución de conflictos es una decisión humana que debe ejecutarse vía CLI: 'npm run canon resolve ${args.entity_key} <winning_value> <event_ids...>'.`;
    }
    if (name === 'canon_audit_repo') {
      return await this.handleAuditTool(store, rootDir);
    }
    return `Herramienta desconocida: ${name}`;
  }

  private async handleAssertTool(args: any, store: EventStore, rootDir: string): Promise<string> {
    if (!this.checkRateLimit(rootDir)) {
      return `❌ Rate limit temporal alcanzado (${this.maxAssertionsPerWindow} aserciones por minuto para este proyecto). Esperá unos segundos antes de reintentar.`;
    }

    const assertCase = new AssertFactUseCase(store);
    const allowNewLeaf = Boolean(args.allow_new_leaf ?? args.new_leaf);

    const res = await assertCase.execute({
      entity_key: args.entity_key,
      slot_type: args.slot_type as SlotCardinality,
      value: args.value,
      authority: Authority.INFERRED,
      supersedes_event_id: args.supersedes_event_id,
      allow_new_leaf: allowNewLeaf,
    });

    if (!res.ok) {
      return `❌ Error al registrar asercion: ${res.error}`;
    }
    return `✅ Asercion registrada con id ${res.event_id} en ${rootDir}. Proyeccion actualizada.`;
  }

  private async handleQueryTool(args: any, store: EventStore, rootDir: string): Promise<string> {
    const queryCase = new QueryActiveStateUseCase(store);
    const res = await queryCase.execute({ anchor: args.anchor });
    return `[Proyecto: ${rootDir}]\n` + res.formattedContext;
  }

  private async handleAuditTool(store: EventStore, rootDir: string): Promise<string> {
    const oracle = new RepoOracle(store, rootDir);
    const audit = await oracle.auditPackageJson();
    return `🔍 Auditoria completada en ${rootDir}.\n- Claves inspeccionadas: ${audit.checked_keys}\n- Desactualizaciones corregidas: ${audit.mismatches_found}\n- Eventos de supersesion emitidos: ${audit.superseded_events.length}`;
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const server = new MCPServer();
  server.startStdio();
}
