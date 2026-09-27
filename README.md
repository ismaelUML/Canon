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
2. **Jerarquía de Autoridad y Reloj Lógico (Lamport Clock):**
   - `USER_EXPLICIT (100)` > `REPO_ORACLE (90)` > `CODE_VERIFIED (80)` > `INFERRED (40)`.
   - Cada evento porta un `logical_ts`. El reductor ordena por causalidad lógica antes de plegar: **inmune a intercalaciones desordenadas de un merge de Git**.
3. **Colaboración en Git y Almacenamiento Híbrido:**
   - **Fuente de verdad:** `.canon/events.jsonl` (append-only de texto plano, versionado en Git, mergeable sin conflictos binarios).
   - **Acelerador local:** `.canon/cache.db` (SQLite efímero en `.gitignore`, invalidado automáticamente por hash SHA-256 al detectar un `git pull`).
   - **Mutex atómico de filesystem:** Bloquea escrituras concurrentes entre múltiples ventanas de Antigravity sobre el mismo repo.
4. **Soporte Nativo para Monorepos (PathResolver):**
   - Búsqueda ascendente desde el archivo activo (`context_path`) hacia el boundary marker más cercano (`package.json`, `go.mod`, etc.).
   - **Techo duro en `.git/`:** La búsqueda jamás cruza la raíz del repositorio hacia carpetas personales del sistema.
5. **Oráculo Mecánico del Repositorio:**
   - Audita automáticamente el disco (`package.json`) contra la memoria activa para auto-corregir dependencias desactualizadas.
6. **Cero Dependencias Externas de NPM:**
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
        "<path-to-canon>/src/adapters/mcp/server.ts"
      ]
    }
  }
}
```
> Reemplazá `<path-to-canon>` con la ruta absoluta donde clonaste el repositorio (por ejemplo, `C:\\Users\\<your-user>\\...` en Windows o `/home/<your-user>/...` en Linux/macOS).
