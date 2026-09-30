// packages/canon_presentation/src/cli/canon_cli.ts
// Canal confiable fuera del alcance del agente: CLI para humanos y hooks verificados.
// Emite eventos firmados criptograficamente con autoridad USER_EXPLICIT (100).
// Complejidad ciclomatica <= 5 garantizada en todos los command handlers.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AssertEvent, SlotCardinality } from '../../../canon_domain/src/index.ts';
import { Authority } from '../../../canon_domain/src/index.ts';
import { resolveProjectRoot, QueryActiveStateUseCase } from '../../../canon_application/src/index.ts';
import { HybridEventStore, signEvent } from '../../../canon_infrastructure/src/index.ts';

export function printHelp(): void {
  console.log(`
Uso de Canon CLI (Canal Confiable):
  canon learn <entity_key> <value> [--slot SINGLE_VALUED|ACCUMULATIVE] [--dir <path>]
  canon query [anchor] [--dir <path>]
  canon register <namespace> [--policy interrupt|soft_lww|auto_latest] [--dir <path>]
  canon resolve <entity_key> <winning_value> <resolves_event_id1> [id2...] [--dir <path>]

Opciones:
  --slot <tipo>               SINGLE_VALUED (defecto) o ACCUMULATIVE
  --dir <path>                Ruta del proyecto (por defecto cwd)
  --interactive-confirmed     Bypass explicito para entornos de CI/Hooks autorizados
`);
}

export function isChannelAuthorized(args: string[]): boolean {
  const isTTY = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const isConfirmed = args.includes('--interactive-confirmed') || process.env.CANON_ALLOW_NON_TTY === '1';
  return isTTY || isConfirmed;
}

export function resolveCliTarget(args: string[]): { canonDir: string; rootDir: string } {
  const dirIndex = args.indexOf('--dir');
  const rawTargetDir = dirIndex !== -1 && args[dirIndex + 1] ? args[dirIndex + 1] : process.cwd();
  const baseCwd = resolve(process.cwd());
  const targetDir = resolve(baseCwd, rawTargetDir);

  if (targetDir.includes('\0') || !targetDir.startsWith(baseCwd)) {
    console.error('❌ Error de seguridad: La ruta del proyecto debe residir dentro del directorio de trabajo actual.');
    process.exit(1);
  }

  return resolveProjectRoot(targetDir);
}

export function normalizeNamespaceString(namespace: string): string {
  if (namespace.endsWith('*')) return namespace;
  if (namespace.endsWith(':')) return namespace + '*';
  return namespace + ':*';
}

export function writeNamespacePolicyEntry(policyPath: string, normalizedNs: string, policyVal: string): void {
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
}

export function handleRegisterCommand(args: string[], rootDir: string): void {
  if (!isChannelAuthorized(args)) {
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
  const normalizedNs = normalizeNamespaceString(namespace);

  writeNamespacePolicyEntry(policyPath, normalizedNs, policyVal);
  console.log(`✅ [CANON REGISTER] Namespace registrado: "${normalizedNs}" con política "${policyVal}" en ${rootDir}`);
}

export function extractLearnArgs(args: string[]): { key: string; val: string } | null {
  const key = args[3];
  const val = args[4];
  if (!key || !val) {
    return null;
  }
  return { key, val };
}

export async function handleLearnCommand(args: string[], rootDir: string, store: HybridEventStore): Promise<void> {
  if (!isChannelAuthorized(args)) {
    console.error('❌ Error de seguridad: canon learn requiere un canal interactivo (TTY) para certificar USER_EXPLICIT.');
    process.exit(1);
  }

  const parsed = extractLearnArgs(args);
  if (!parsed) {
    console.error('❌ Error: Se requiere <entity_key> y <value>.');
    printHelp();
    process.exit(1);
  }

  const slotIndex = args.indexOf('--slot');
  const slotType: SlotCardinality = slotIndex !== -1 && args[slotIndex + 1] === 'ACCUMULATIVE' ? 'ACCUMULATIVE' : 'SINGLE_VALUED';
  const eventId = `evt_${randomUUID()}`;

  const rawEvent: AssertEvent = {
    id: eventId,
    schema_version: 1,
    entity_key: parsed.key,
    logical_ts: 0,
    slot_type: slotType,
    value: parsed.val,
    authority: Authority.USER_EXPLICIT,
    created_at: new Date().toISOString(),
    type: 'ASSERT',
  };

  await store.withLock(async () => {
    const allEvents = await store.getAllEvents();
    const maxTs = allEvents.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
    rawEvent.logical_ts = maxTs + 1;
    rawEvent.signature = signEvent(rawEvent);
    store.appendUnlocked(rawEvent);
  });

  console.log(`✅ [CANON LEARN] Hecho registrado con autoridad USER_EXPLICIT (100) en ${rootDir}`);
  console.log(`   ID: ${eventId}`);
  console.log(`   Clave: ${parsed.key} = ${parsed.val}`);
  console.log(`   Firma HMAC: ${rawEvent.signature?.slice(0, 16)}...`);
}

export async function handleResolveCommand(args: string[], rootDir: string, store: HybridEventStore): Promise<void> {
  if (!isChannelAuthorized(args)) {
    console.error('❌ Error de seguridad: canon resolve requiere confirmación humana interactiva (TTY).');
    process.exit(1);
  }

  const key = args[3];
  const winningVal = args[4];
  const resolveIds = args.slice(5).filter((a) => !a.startsWith('--'));
  if (!key || !winningVal || resolveIds.length === 0) {
    console.error('❌ Error: Se requiere <entity_key> <winning_value> <resolves_event_id1> [id2...]');
    process.exit(1);
  }

  const eventId = `res_${randomUUID()}`;
  const resolveEvent = {
    id: eventId,
    schema_version: 1,
    entity_key: key,
    logical_ts: 0,
    resolves_event_ids: resolveIds,
    winning_value: winningVal,
    authority: Authority.USER_EXPLICIT,
    created_at: new Date().toISOString(),
    type: 'RESOLVE_CONFLICT' as const,
    signature: '',
  };

  await store.withLock(async () => {
    const allEvents = await store.getAllEvents();
    const maxTs = allEvents.reduce((max, e) => Math.max(max, e.logical_ts ?? 0), 0);
    resolveEvent.logical_ts = maxTs + 1;
    resolveEvent.signature = signEvent(resolveEvent);
    store.appendUnlocked(resolveEvent);
  });

  console.log(`✅ [CANON RESOLVE] Conflicto resuelto para '${key}'. Hecho ganador: '${winningVal}' (id: ${eventId})`);
}

export async function handleQueryCommand(args: string[], rootDir: string, store: HybridEventStore): Promise<void> {
  const anchor = args[3] && !args[3].startsWith('--') ? args[3] : undefined;
  const queryCase = new QueryActiveStateUseCase(store);
  const res = await queryCase.execute({ anchor });
  console.log(`[Proyecto: ${rootDir}]`);
  console.log(res.formattedContext);
}

async function dispatchStoreCommand(
  command: string,
  args: string[],
  rootDir: string,
  store: HybridEventStore
): Promise<void> {
  if (command === 'learn') {
    await handleLearnCommand(args, rootDir, store);
    return;
  }
  if (command === 'resolve') {
    await handleResolveCommand(args, rootDir, store);
    return;
  }
  if (command === 'query') {
    await handleQueryCommand(args, rootDir, store);
    return;
  }
  console.error(`Comando desconocido: ${command}`);
  printHelp();
  process.exit(1);
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[2];
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const { canonDir, rootDir } = resolveCliTarget(args);
  if (command === 'register') {
    handleRegisterCommand(args, rootDir);
    return;
  }

  const store = new HybridEventStore(canonDir);
  try {
    await dispatchStoreCommand(command, args, rootDir, store);
  } finally {
    store.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('canon_cli.ts')) {
  runCli(process.argv).catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
