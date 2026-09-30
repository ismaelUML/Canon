// packages/canon_infrastructure/src/crypto/signer.ts
// Candado criptografico de Canon: firma y verifica eventos de alta autoridad.
// La clave secreta HMAC vive FUERA del workspace para que ni la inyeccion de prompts
// ni la manipulacion de archivos por agentes descontrolados puedan falsificar autoridad.
// Complejidad ciclomatica <= 5 garantizada en todas las subfunciones.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEvent } from '../../../canon_domain/src/index.ts';

export function getDefaultKeyPath(): string {
  return process.env.CANON_KEY_PATH || join(homedir(), '.canon', 'secret.key');
}

export function getOrCreateSecretKey(customPath?: string): string {
  const keyPath = customPath || getDefaultKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }

  const parentDir = join(keyPath, '..');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const secret = randomBytes(32).toString('hex');
  writeFileSync(keyPath, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

export function extractEventValue(event: MemoryEvent): string {
  if (event.type === 'ASSERT') return event.value;
  if (event.type === 'SUPERSEDE') return event.new_value;
  return event.winning_value;
}

export function extractSupersedesId(event: MemoryEvent): string {
  if (event.type === 'SUPERSEDE') return event.supersedes_event_id;
  if (event.type === 'ASSERT') return event.supersedes_event_id ?? '';
  return '';
}

export function extractResolvesIds(event: MemoryEvent): string {
  if (event.type === 'RESOLVE_CONFLICT') {
    return JSON.stringify(event.resolves_event_ids);
  }
  return '';
}

export function getEventSignaturePayload(event: MemoryEvent): string {
  const value = extractEventValue(event);
  const supersedesId = extractSupersedesId(event);
  const resolvesIds = extractResolvesIds(event);

  return [
    String(event.schema_version ?? 1),
    event.id,
    event.entity_key,
    String(event.logical_ts ?? 0),
    String(event.authority),
    event.type,
    value,
    supersedesId,
    resolvesIds,
    event.created_at,
  ].join('|');
}

export function signEvent(event: MemoryEvent, secretKey?: string): string {
  const key = secretKey || getOrCreateSecretKey();
  const payload = getEventSignaturePayload(event);
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function verifyEventSignature(event: MemoryEvent, secretKey?: string): boolean {
  if (!event.signature) {
    return false;
  }
  const key = secretKey || getOrCreateSecretKey();
  const payload = getEventSignaturePayload(event);
  const expectedSignature = createHmac('sha256', key).update(payload).digest('hex');

  const actualBuf = Buffer.from(event.signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}
