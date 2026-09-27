# Canon: Deterministic Truth-Maintenance Memory for AI Coding Agents

> **Memoria determinística basada en Event Sourcing y mantenimiento de verdad para agentes de código.**
> Resuelve obsolescencia, envenenamiento y contradicciones sin depender de similitud vectorial o adivinanzas de LLMs.

---

## 🏛️ Arquitectura Hexagonal

```
scratch/canon/
├── src/
│   ├── domain/               # Core puro: cero I/O, complejidad ciclomática <= 5
│   │   ├── models.ts         # Eventos inmutables, active facts y conflictos
│   │   ├── policy.ts         # Reglas de amortiguación por namespace
│   │   ├── fold.ts           # Reductor puro: (Event[], Policy) -> Projection
│   │   └── security.ts       # Filtro defensivo: cero secretos o tokens
│   │
│   ├── ports/
│   │   └── event_store.ts    # Interfaz EventStore desacoplada
│   │
│   ├── adapters/
│   │   ├── storage/
│   │   │   ├── in_memory.ts  # Fake para tests instantáneos
│   │   │   └── sqlite_store.ts # SQLite nativo (node:sqlite) 100% parametrizado
│   │   ├── oracle/
│   │   │   └── repo_oracle.ts  # Verificación contra package.json
│   │   └── mcp/
│   │       └── server.ts     # Servidor MCP stdio para Antigravity
│   │
│   └── use_cases/            # Casos de uso con cuotas anti-loop
│       ├── assert_fact.ts
│       ├── query_active_state.ts
│       └── resolve_conflict.ts
│
└── tests/
    ├── benchmark/
    │   └── test_staleness_ci.test.ts # TEST #1 DE CI: Detección de obsolescencia
    └── unit/
        ├── test_sqlite_and_security.test.ts
        ├── test_use_cases.test.ts
        ├── test_repo_oracle.test.ts
        └── test_mcp_server.test.ts
```

---

## 🚀 Principios Clave

1. **Supersesión Estructural por Cardinalidad:**
   - **Slots de valor único** (`SINGLE_VALUED`): `dep:tailwindcss:version`, `db:pk_format`. Una nueva aserción **es** una supersesión automática. Sin NLP.
   - **Slots acumulativos** (`ACCUMULATIVE`): `learned:gotchas:*`. Conviven como lista aditiva de quirks.
2. **Jerarquía de Autoridad:**
   - `USER_EXPLICIT (100)` > `REPO_ORACLE (90)` > `CODE_VERIFIED (80)` > `INFERRED (40)`.
   - Inferencias vagas jamás voltean decisiones explícitas del usuario.
3. **Detección de Conflictos via Point Lookup:**
   - La colisión se detecta en tiempo de inserción indexada sobre SQLite en <1ms.
   - En namespaces críticos (`db:*`, `security:*`), la misma autoridad no pisa silenciosamente; dispara un estado `CONFLICT`.
4. **Oráculo Mecánico del Repositorio:**
   - Audita automáticamente el disco (`package.json`) contra la memoria activa para auto-corregir dependencias desactualizadas.
5. **Cero Dependencias Externas de NPM:**
   - Utiliza TypeScript nativo (`--experimental-strip-types`), `node:sqlite` nativo y `node:test` nativo de Node 24.

---

## 🧪 Ejecutar Tests y Staleness Benchmark

```bash
npm test
```

Los 13 tests (incluyendo el benchmark de staleness) se ejecutan en **~200 ms**.

---

## 🔌 Configuración en Antigravity IDE

Para conectar Canon a Antigravity mediante MCP, agregá la siguiente entrada en tu archivo `mcp_config.json`:

```json
{
  "mcpServers": {
    "canon": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "C:\\Users\\Danie\\.gemini\\antigravity-ide\\scratch\\canon\\src\\adapters\\mcp\\server.ts"
      ]
    }
  }
}
```
