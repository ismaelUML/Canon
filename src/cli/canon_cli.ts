// src/cli/canon_cli.ts
// Canal confiable fuera del alcance del agente: CLI para humanos y hooks verificados.
// Emite eventos firmados criptograficamente con autoridad USER_EXPLICIT (100)
// usando la clave HMAC que reside fuera del workspace.

import { randomUUID } from 'node:crypto';
import { resolveProjectRoot } from '../adapters/resolver/path_resolver.ts';
import { HybridEventStore } from '../adapters/storage/hybrid_store.ts';
import { Authority } from '../domain/models.ts';
import type { AssertEvent, SlotCardinality } from '../domain/models.ts';
import { signEvent } from '../adapters/crypto/signer.ts';
import { QueryActiveStateUseCase } from '../use_cases/query_active_state.ts';

function printHelp(): void {
  console.log(`
Uso de Canon CLI (Canal Confiable):
  canon learn <entity_key> <value> [--slot SINGLE_VALUED|ACCUMULATIVE] [--dir <path>]
  canon query [anchor] [--dir <path>]

Opciones:
  --slot <tipo>               SINGLE_VALUED (defecto) o ACCUMULATIVE
  --dir <path>                Ruta del proyecto (por defecto cwd)
  --interactive-confirmed     Bypass explicito para entornos de CI/Hooks autorizados
`);
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[2];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const dirIndex = args.indexOf('--dir');
  const targetDir = dirIndex !== -1 && args[dirIndex + 1] ? args[dirIndex + 1] : process.cwd();
  const { canonDir, rootDir } = resolveProjectRoot(targetDir);
  const store = new HybridEventStore(canonDir);

  if (command === 'learn') {
    // Valla interactiva: frena agentes headless sin terminal asignada
    const isTTY = Boolean(process.stdin.isTTY || process.stdout.isTTY);
    const isConfirmed = args.includes('--interactive-confirmed') || process.env.CANON_ALLOW_NON_TTY === '1';

    if (!isTTY && !isConfirmed) {
      console.error('❌ Error de seguridad: canon learn requiere un canal interactivo (TTY) para certificar USER_EXPLICIT.');
      process.exit(1);
    }

    const key = args[3];
    const val = args[4];

    if (!key || !val) {
      console.error('❌ Error: Se requiere <entity_key> y <value>.');
      printHelp();
      process.exit(1);
    }

    const slotIndex = args.indexOf('--slot');
    const slotType: SlotCardinality =
      slotIndex !== -1 && args[slotIndex + 1] === 'ACCUMULATIVE' ? 'ACCUMULATIVE' : 'SINGLE_VALUED';

    const eventId = `evt_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    const rawEvent: AssertEvent = {
      id: eventId,
      schema_version: 1,
      entity_key: key,
      logical_ts: 0,
      slot_type: slotType,
      value: val,
      authority: Authority.USER_EXPLICIT, // 100
      created_at: createdAt,
      type: 'ASSERT',
    };

    // Candado criptografico: firmar con HMAC fuera del workspace
    rawEvent.signature = signEvent(rawEvent);

    await store.append(rawEvent);
    console.log(`✅ [CANON LEARN] Hecho registrado con autoridad USER_EXPLICIT (100) en ${rootDir}`);
    console.log(`   ID: ${eventId}`);
    console.log(`   Clave: ${key} = ${val}`);
    console.log(`   Firma HMAC: ${rawEvent.signature.slice(0, 16)}...`);
    return;
  }

  if (command === 'query') {
    const anchor = args[3] && !args[3].startsWith('--') ? args[3] : undefined;
    const queryCase = new QueryActiveStateUseCase(store);
    const res = await queryCase.execute({ anchor });
    console.log(`[Proyecto: ${rootDir}]`);
    console.log(res.formattedContext);
    return;
  }

  if (command === 'register') {
    const isTTY = Boolean(process.stdin.isTTY || process.stdout.isTTY);
    const isConfirmed = args.includes('--interactive-confirmed') || process.env.CANON_ALLOW_NON_TTY === '1';

    if (!isTTY && !isConfirmed) {
      console.error('❌ Error de seguridad: canon register requiere un canal interactivo (TTY) para autorizar nuevos namespaces.');
      process.exit(1);
    }

    const namespace = args[3];
    if (!namespace) {
      console.error('❌ Error: Se requiere <namespace> (ej: architecture, payment:*).');
      printHelp();
      process.exit(1);
    }

    const policyIndex = args.indexOf('--policy');
    const policyVal = policyIndex !== -1 && args[policyIndex + 1] ? args[policyIndex + 1] : 'interrupt';

    const policyPath = join(rootDir, 'canon_policy.yaml');
    const normalizedNs = namespace.endsWith('*') ? namespace : namespace.endsWith(':') ? namespace + '*' : namespace + ':*';
    const entry = `  "${normalizedNs}": "${policyVal}"\n`;

    if (existsSync(policyPath)) {
      const content = readFileSync(policyPath, 'utf8');
      if (!content.includes(`"${normalizedNs}"`)) {
        const updated = content.replace(/(rules:\s*\n)/, `$1${entry}`);
        writeFileSync(policyPath, updated, 'utf8');
      }
    } else {
      const newContent = `rules:\n${entry}\ndefaultPolicy: "interrupt"\n`;
      writeFileSync(policyPath, newContent, 'utf8');
    }

    console.log(`✅ [CANON REGISTER] Namespace registrado: "${normalizedNs}" con política "${policyVal}" en ${rootDir}`);
    return;
  }

  console.error(`Comando desconocido: ${command}`);
  printHelp();
  process.exit(1);
}

// Ejecucion CLI directa
if (process.argv[1] && process.argv[1].endsWith('canon_cli.ts')) {
  runCli(process.argv).catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
