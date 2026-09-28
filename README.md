# Canon: Deterministic Truth-Maintenance Memory for AI Coding Agents

> **Memoria determinística basada en Event Sourcing y mantenimiento de verdad para agentes de código.**
> Resuelve obsolescencia, envenenamiento y contradicciones sin depender de similitud vectorial o adivinanzas de LLMs.

---

## Arquitectura Hexagonal

```
scratch/canon/
├── src/
│   ├── domain/               # Core puro: cero I/O, complejidad ciclomática <= 5
│   │   ├── models.ts         # Eventos inmutables, active facts y conflictos
│   │   ├── policy.ts         # Reglas de amortiguación por namespace y extracción de subsistemas
│   │   ├── fold.ts           # Reductor puro: (Event[], Policy, SignatureVerifier) -> Projection
│   │   └── security.ts       # Filtro defensivo: cero secretos o tokens
│   │
│   ├── ports/
│   │   └── event_store.ts    # Interfaz EventStore desacoplada (withLock, appendUnlocked)
│   │
│   ├── adapters/
│   │   ├── storage/
│   │   │   ├── in_memory.ts  # Fake para tests instantáneos en microsegundos
│   │   │   ├── sqlite_store.ts # SQLite puro (node:sqlite)
│   │   │   └── hybrid_store.ts # events.jsonl + cache SQLite + mutex FS + stale lock recovery
│   │   ├── crypto/
│   │   │   └── signer.ts     # HMAC-SHA256 para eventos de alta autoridad (USER_EXPLICIT)
│   │   ├── resolver/
│   │   │   └── path_resolver.ts # Aislamiento monorepo con boundary techo en .git
│   │   ├── oracle/
│   │   │   └── repo_oracle.ts  # Verificación mecánica contra package.json
│   │   └── mcp/
│   │       └── server.ts     # Servidor MCP stdio nativo JSON-RPC 2.0 (canon_assert, canon_query, canon_audit)
│   │
│   ├── cli/
│   │   └── canon_cli.ts      # Canal confiable humano (learn, resolve, register) con firma HMAC y TTY
│   │
│   └── use_cases/            # Casos de uso con cuotas y validación fail-closed
│       ├── assert_fact.ts
│       ├── query_active_state.ts
│       └── resolve_conflict.ts
│
└── tests/
    ├── benchmark/
    │   └── test_staleness_ci.test.ts # Benchmarks de supersesión, amortiguación y jerarquía
    └── unit/
        ├── test_sqlite_and_security.test.ts
        ├── test_use_cases.test.ts
        ├── test_repo_oracle.test.ts
        ├── test_mcp_server.test.ts
        ├── test_hmac_authority_degradation.test.ts
        └── test_hybrid_and_resolver.test.ts
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
3. **Prevención de Bifurcación Léxica:**
   - Si ya existen hojas en un subsistema (ej: `branch_naming` en `convention:git`), un agente (autoridad <= 40) **no puede inventar una hoja sinónima** (ej: `branch_format`). Para crear nuevas hojas bajo un subsistema existente, se requiere el canal humano (`npm run canon learn`).
4. **Acotamiento de Disputas (Anti-Spam):**
   - Máximo **1 disputa por clave** y un tope de **5 disputas abiertas en simultáneo**, evitando que un agente degrade el contexto llenando el prompt de alertas ⚠️.

### Lo que Canon NO Protege (Frontera del Entorno de Ejecución)

> [!WARNING]
> **Frontera de Confianza:** Canon protege contra **errores del LLM, alucinaciones, inyecciones de prompt y ediciones no autorizadas de archivos o MCP**, **NO** contra un agente que cuente con permisos de ejecución en tu terminal y acceso irrestricto a tu directorio de usuario (`~`).
> 
> - La clave secreta vive en `~/.canon/secret.key`. Un agente con herramienta de ejecución en terminal y auto-aprobación del usuario puede hacer `cat ~/.canon/secret.key` o correr comandos de Node.
> - La verificación `isTTY` es una salvaguarda de UX contra scripts desatendidos, pero las terminales integradas en IDEs modernos (PTY) pueden simular un TTY interactivo.
> - La seguridad absoluta contra procesos del mismo usuario a nivel de SO requiere aislamiento en contenedores o sandboxing del agente fuera del host.

---

## Degradación en Multi-Máquina y Equipos (Roadmap v2)

En la versión actual (v1), la clave HMAC es una clave simétrica local en `~/.canon/secret.key`.

- **Comportamiento en segunda máquina o clon:** Si clonás el repositorio en otra máquina sin copiar `~/.canon/secret.key`, o si un compañero de equipo hace commit de un evento firmado con su propia clave, Canon detecta la discrepancia de firma y **degrada los eventos afectados a autoridad 40 (`INFERRED`)**.
- **Aviso Visible (Cero Degradación Silenciosa):** Al consultar el estado con `canon_query_active`, Canon emite una alerta destacada:
  ```
  ⚠️ ALERTA DE SEGURIDAD: N hecho(s) tienen firma HMAC ausente o inválida y fueron degradados a autoridad 40 (posible cambio de máquina, falta de clave en ~/.canon/secret.key o evento de compañero de equipo).
  ```
- **Solución definitiva para equipos (v2):** Reemplazo de HMAC simétrico por firmas asimétricas de clave pública/privada (ej: ed25519 o llaves SSH/GPG por desarrollador) con un archivo `canon_keys.json` en el repositorio.

---

## Concurrencia y Recuperación de Locks

1. **Locks Inter-Proceso Reales:** Probado con múltiples subprocesos de Node (`child_process.fork`) compitiendo simultáneamente contra `events.jsonl` bajo mutex atómico (`mkdirSync`).
2. **Recuperación Automática de Stale Locks:** Si el IDE o el proceso MCP muere inesperadamente dejando `events.jsonl.lock` en disco, los procesos posteriores detectan si el lock tiene más de 5 segundos de antigüedad, lo rompen automáticamente y continúan sin requerir intervención manual.
3. **Rate Limiter de Ráfaga:** 10 aserciones por minuto por proyecto en memoria de proceso como stopgap anti-bucle hasta la implementación de `turn_id` a nivel de protocolo MCP.

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

## Ejecutar Tests y Benchmarks

```bash
npm test
```

Los **28 tests unitarios, benchmarks y pruebas de concurrencia inter-proceso** se ejecutan en **~600 ms** utilizando Node 24 sin dependencias externas.
