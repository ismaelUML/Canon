# Canon: Deterministic Truth-Maintenance Memory for AI Coding Agents

> **Memoria determinística basada en Event Sourcing y mantenimiento de verdad para agentes de código.**
> Resuelve obsolescencia, envenenamiento y contradicciones sin depender de similitud vectorial o adivinanzas de LLMs.

---

## Arquitectura Hexagonal y Modularización Física

Canon está estructurado en 4 paquetes concéntricos totalmente desacoplados bajo workspaces de npm, cumpliendo estrictamente con la Regla de Dependencia Unidireccional Inversa y límites de complejidad ciclomática ($CC \le 5$ e Índice de Mantenibilidad $MI \ge 75$):

```
canon/
├── .github/
│   └── workflows/
│       └── ci.yml                          # CI Pipeline: Lint de Complejidad, Métricas Martin, SQALE y SonarCloud
│
├── packages/
│   ├── canon_domain/                       # Capa 1: Dominio Puro (0 dependencias externas, 0 I/O)
│   │   └── src/
│   │       ├── models.ts                   # Eventos inmutables, active facts y estados de conflicto
│   │       ├── policy.ts                   # Reglas de amortiguación por namespace y extracción de subsistemas
│   │       ├── fold.ts                     # Reductor puro determinista: (Event[], Policy) -> Projection
│   │       ├── security.ts                 # Sanitizador defensivo contra fuga de secretos y credenciales
│   │       └── ports/
│   │           └── event_store.ts          # Contrato desacoplado EventStore (withLock, appendUnlocked)
│   │
│   ├── canon_application/                  # Capa 2: Casos de Uso y Oráculo Mecánico
│   │   └── src/
│   │       ├── use_cases/
│   │       │   ├── assert_fact.ts          # Aserción con validación fail-closed y cuotas
│   │       │   ├── query_active_state.ts   # Consulta y formateo de contexto para prompts de LLM
│   │       │   └── resolve_conflict.ts     # Arbitraje y resolución explícita de disputas
│   │       ├── oracle/
│   │       │   └── repo_oracle.ts          # Oráculo mecánico contra package.json
│   │       └── resolver/
│   │           └── path_resolver.ts        # Aislamiento monorepo con boundary techo en .git
│   │
│   ├── canon_infrastructure/               # Capa 3: Adaptadores de Salida (Persistencia y Criptografía)
│   │   └── src/
│   │       ├── storage/
│   │       │   ├── in_memory.ts            # Fake en memoria para tests instantáneos
│   │       │   ├── sqlite_store.ts         # SQLite nativo (node:sqlite)
│   │       │   └── hybrid_store.ts         # events.jsonl + cache SQLite + mutex FS + validación de path
│   │       ├── crypto/
│   │       │   └── signer.ts               # HMAC-SHA256 con cobertura campo por campo (USER_EXPLICIT)
│   │       └── resilience/
│   │           └── circuit_breaker.ts      # Circuit Breaker failover con estados Closed/Open/HalfOpen
│   │
│   └── canon_presentation/                 # Capa 4: Adaptadores de Entrada (Driving)
│       └── src/
│           ├── cli/
│           │   └── canon_cli.ts            # Canal confiable humano (learn, resolve, register)
│           ├── concurrency/
│           │   └── bounded_queue.ts        # Cola con contrapresión (backpressure saturación 429)
│           └── mcp/
│               └── server.ts               # Servidor MCP stdio nativo JSON-RPC 2.0
│
├── scripts/                                # Auditores Deterministas de Arquitectura y Calidad
│   ├── check_complexity.ts                 # Validador de Complejidad Ciclomática (CC <= 5) y MI (>= 75)
│   ├── audit_metrics.ts                    # Auditor de Acoplamiento y Distancia (Robert C. Martin D < 0.70)
│   └── sqale_audit.ts                      # Modelo financiero de deuda técnica SQALE + Capers Jones F(MI)
│
└── tests/                                  # Suite de Pruebas Automatizadas (34 tests)
    ├── benchmark/
    │   └── test_staleness_ci.test.ts       # Benchmarks de supersesión, amortiguación y jerarquía
    ├── helpers/
    │   └── concurrency_worker.ts           # Workers auxiliares para concurrencia multi-proceso
    └── unit/
        ├── test_sqlite_and_security.test.ts
        ├── test_use_cases.test.ts
        ├── test_repo_oracle.test.ts
        ├── test_mcp_server.test.ts
        ├── test_hmac_authority_degradation.test.ts
        ├── test_hybrid_and_resolver.test.ts
        └── test_resilience_and_backpressure.test.ts
```

---

## Modelo de Amenazas y Límites de Seguridad

### Lo que Canon SÍ Protege (Garantías Fuertes)

1. **Invariante Fuerte de Autoridad:**
   - **Ninguna secuencia de llamadas MCP (`assert`, `supersede`, `resolve`) puede cambiar el valor activo de un hecho con autoridad mayor a 40 (`USER_EXPLICIT` = 100 o `CODE_VERIFIED` = 80).**
   - El endpoint `canon_resolve_conflict` **no está expuesto en MCP**. La resolución de disputas es estrictamente humana y requiere el CLI (`canon resolve`).
2. **Defensa Criptográfica contra Inyección de Prompts y Manipulación de Archivos:**
   - Si un agente alucinado o un prompt inyectado escribe manualmente una línea con `"authority": 100` en `events.jsonl`, el motor detecta la falta de firma HMAC válida y **degrada el evento inmediatamente a 40 (`INFERRED`)**.
   - **Cobertura exhaustiva de la firma HMAC:** La firma cubre campo por campo: `schema_version`, `id`, `entity_key`, `logical_ts`, `authority`, `type`, `value`, `supersedes_event_id`, `resolves_event_ids`, y `created_at`.
   - **Anti-Resurrección de Hechos:** Si se intenta mover un evento firmado antiguo al final del log alterando su `logical_ts`, la firma se invalida, el evento se degrada a 40 y el hecho supersedido no resucita.
   - **Deduplicación Estricta por ID:** Copiar una línea firmada N veces en `events.jsonl` es deduplicado por ID antes del fold y en SQLite, impidiendo ataques de replay en slots `ACCUMULATIVE`.
3. **Defensa contra Path Traversal y Connection String Injection:**
   - Verificación estricta de rutas con `path.relative`, control de bytes nulos (`\0`), limitación a extensiones esperadas (`.lock`, `.jsonl`, `.db`) y rechazo de URIs SQLite no deseadas (`file:...?mode=...`).
4. **Prevención de Bifurcación Léxica:**
   - Si ya existen hojas en un subsistema (ej: `branch_naming` en `convention:git`), un agente (autoridad <= 40) **no puede inventar una hoja sinónima** (ej: `branch_format`). Para crear nuevas hojas bajo un subsistema existente, se requiere el canal humano (`npm run canon learn`).
5. **Acotamiento de Disputas (Anti-Spam):**
   - Máximo **1 disputa por clave** y un tope de **5 disputas abiertas en simultáneo**, evitando que un agente degrade el contexto llenando el prompt de alertas ⚠️.

### Lo que Canon NO Protege (Frontera del Entorno de Ejecución)

> [!WARNING]
> **Frontera de Confianza:** Canon protege contra **errores del LLM, alucinaciones, inyecciones de prompt y ediciones no autorizadas de archivos o MCP**, **NO** contra un agente que cuente con permisos de ejecución en tu terminal y acceso irrestricto a tu directorio de usuario (`~`).
> 
> - La clave secreta vive en `~/.canon/secret.key`. Un agente con herramienta de ejecución en terminal y auto-aprobación del usuario puede hacer `cat ~/.canon/secret.key` o correr comandos de Node.
> - La verificación `isTTY` es una salvaguarda de UX contra scripts desatendidos, pero las terminales integradas en IDEs modernos (PTY) pueden simular un TTY interactivo.
> - La seguridad absoluta contra procesos del mismo usuario a nivel de SO requiere aislamiento en contenedores o sandboxing del agente fuera del host.

---

## Concurrencia, Resiliencia y Backpressure

1. **Locks Inter-Proceso Reales:** Probado con múltiples subprocesos de Node (`child_process.fork`) compitiendo simultáneamente contra `events.jsonl` bajo mutex atómico (`mkdirSync`).
2. **Recuperación Automática de Stale Locks:** Si el IDE o el proceso MCP muere inesperadamente dejando `events.jsonl.lock` en disco, los procesos posteriores detectan si el lock tiene más de 5 segundos de antigüedad, lo rompen automáticamente y continúan sin requerir intervención manual.
3. **Circuit Breaker:** Protege adaptadores I/O ante fallos en cascada. Tras 3 fallos consecutivos abre el circuito conmutando al almacén alternativo de fallback de manera determinista.
4. **Bounded Task Queue:** Cola de ejecución concurrente con límite duro de saturación (Tope: 50 tareas, Concurrencia: 4 workers). Dispara rechazo inmediato de saturación (código 429) evitando acumulación descontrolada de memoria.
5. **Cancelación Reactiva:** Soporte cooperativo de `AbortSignal` propagado a través de casos de uso y adaptadores para interrumpir operaciones en vuelo.

---

## Configuración en Antigravity IDE (MCP)

Para conectar Canon a Antigravity mediante MCP, agregá la siguiente entrada en tu archivo `mcp_config.json`:

```json
{
  "mcpServers": {
    "canon": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "<path-to-canon>/packages/canon_presentation/src/mcp/server.ts"
      ]
    }
  }
}
```
> Reemplazá `<path-to-canon>` con la ruta absoluta donde clonaste el repositorio (por ejemplo, `C:\\Users\\<your-user>\\...` en Windows o `/home/<your-user>/...` en Linux/macOS).

---

## Comandos del CLI Humano

```bash
# Registrar un hecho con máxima autoridad (USER_EXPLICIT = 100) firmado
npm run canon learn convention:git:branch_naming "feat/*"

# Resolver una disputa pendiente eligiendo el valor ganador
npm run canon resolve convention:git:branch_naming "feat/*" evt_123 evt_456

# Registrar un nuevo namespace en canon_policy.yaml
npm run canon register "infra:*" --policy interrupt
```

---

## Ejecutar Tests, Cobertura y Auditorías Arquitectónicas

```bash
# 1. Ejecutar toda la suite de pruebas (34 tests unitarios y benchmarks)
npm test

# 2. Generar reporte de cobertura LCOV para SonarCloud
npm run test:coverage

# 3. Auditoría integral de calidad, arquitectura y complejidad
npm run audit
```

### Scripts de Auditoría Determinista:
- **`npm run lint:complexity`**: Verifica que ninguna función exceda Complejidad Ciclomática $CC \le 5$ y que el Índice de Mantenibilidad sea $MI \ge 75$.
- **`npm run audit:metrics`**: Calcula métricas estructurales de Robert C. Martin ($C_a, C_e, I, A, D$) asegurando que la distancia a la secuencia principal cumpla $D < 0.70$.
- **`npm run audit:sqale`**: Ejecuta el modelo financiero de deuda técnica SQALE y fricción operativa de Capers Jones ($TDR < 5.0\%$, Deuda Técnica = $0).
