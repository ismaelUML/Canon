// tests/helpers/concurrency_worker.ts
// Worker de proceso separado para pruebas reales de concurrencia e inter-process locks.

import { resolve, dirname, basename } from 'node:path';
import { HybridEventStore } from '../../packages/canon_infrastructure/src/storage/hybrid_store.ts';
import { Authority } from '../../packages/canon_domain/src/models.ts';
import type { AssertEvent } from '../../packages/canon_domain/src/models.ts';

const rawCanonDir = process.argv[2];
const prefix = process.argv[3];
const count = Number.parseInt(process.argv[4] ?? '5', 10);

if (!rawCanonDir || !prefix || Number.isNaN(count)) {
  process.exit(1);
}

// Sanitizar y validar ruta contra Path Traversal
const canonDir = resolve(rawCanonDir);
const parentDir = dirname(canonDir);
const dirName = basename(canonDir);

if (
  canonDir.includes('\0') ||
  !canonDir.startsWith(parentDir) ||
  basename(canonDir) !== dirName ||
  dirName !== '.canon'
) {
  process.exit(1);
}

async function run() {
  const store = new HybridEventStore(canonDir);

  for (let i = 0; i < count; i++) {
    const evt: AssertEvent = {
      id: `evt_${prefix}_${i}`,
      entity_key: `test:proc:${prefix}:${i}`,
      logical_ts: 0,
      slot_type: 'SINGLE_VALUED',
      value: `val_${prefix}_${i}`,
      authority: Authority.USER_EXPLICIT,
      created_at: new Date().toISOString(),
      type: 'ASSERT',
    };
    await store.append(evt);
  }

  store.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(`Error en worker ${prefix}:`, err);
  process.exit(1);
});
