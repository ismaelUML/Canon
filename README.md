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

## Principios Clave y Modelo de Amenazas

1. **Jerarquía de Autoridad y Candado HMAC (Defensa contra Inyecciones):**
   - **Canal de Máxima Autoridad (`USER_EXPLICIT = 100`):** Solo accesible vía canal confiable (`npm run canon learn`), firmado con clave secreta HMAC-SHA256 almacenada fuera del workspace (`~/.canon/secret.key`) y con valla interactiva TTY.
   - **Canal MCP de Agentes:** Toda llamada vía `canon_assert_fact` está estrictamente fijada en **`INFERRED = 40`**. Ningún parámetro del agente puede alterar su autoridad.
   - **Degradación Criptográfica Automática:** Si un atacante o prompt injection pega una línea con `"authority": 100` directamente en `events.jsonl`, el motor detecta la falta de firma HMAC y **degrada el evento inmediatamente a 40 (`INFERRED`)**.
2. **Gobernanza Fail-Closed y Prevención de Bifurcación Léxica:**
   - **Fail-Closed en Namespaces:** Cualquier clave fuera de `canon_policy.yaml` se rechaza. Para habilitar un nuevo subsistema, el humano debe registrarlo con `npm run canon register <namespace>`.
   - **Validación de Hojas:** Si en `convention:git` ya existe la hoja `branch_naming`, un intento del agente de asertar `branch_format` es bloqueado informándole las hojas conocidas, a menos que pase explícitamente `new_leaf: true`.
3. **Registro de Desafíos (No se pierde la señal):**
   - Si un evento de autoridad 40 (inferido) contradice un hecho de autoridad superior (100 u 80), **no se rechaza en silencio**. Se almacena y se marca en **disputa (`CONFLICT`)**, permitiendo que `canon_query_active` muestre el hecho con la etiqueta `⚠️ [EN DISPUTA]` para arbitraje humano.
4. **Supersesión Estructural por Cardinalidad:**
   - **Slots de valor único** (`SINGLE_VALUED`): `dep:tailwindcss:version`, `db:pk_format`. Una nueva aserción legítima supersede la anterior sin adivinanzas de NLP.
   - **Slots acumulativos** (`ACCUMULATIVE`): `learned:gotchas:*`. Conviven como lista aditiva de quirks.
5. **Reloj Lógico de Lamport y Almacenamiento Híbrido:**
   - **Fuente de verdad:** `.canon/events.jsonl` (append-only de texto plano, versionado en Git, mergeable sin conflictos binarios).
   - **Acelerador local:** `.canon/cache.db` (SQLite efímero en `.gitignore`, invalidado automáticamente por hash SHA-256 al detectar un `git pull`).
   - **Mutex atómico de filesystem:** `withLock()` envuelve lectura + decisión + append de forma atómica para prevenir condiciones de carrera entre ventanas concurrentes.
6. **Stopgap Anti-Loop:**
   - Rate limit temporal de ráfaga (10 aserciones por minuto por proyecto) como stopgap mientras se implementa el `turn_id` a nivel de cliente.
7. **Cero Dependencias Externas de NPM:**
   - Utiliza TypeScript nativo (`--experimental-strip-types`), `node:sqlite` nativo y `node:test` nativo de Node 24. Tests ejecutados en **~500 ms**.

---

## Ejecutar Tests y Staleness Benchmark

```bash
npm test
```

Los 13 tests (incluyendo el benchmark de staleness) se ejecutan en **~200 ms**.

---

## Configuración en Antigravity IDE

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
