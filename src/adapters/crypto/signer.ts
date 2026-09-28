// src/adapters/crypto/signer.ts
// Candado criptografico de Canon: firma y verifica eventos de alta autoridad.
// La clave secreta HMAC vive FUERA del workspace para que ni la inyeccion de prompts
// ni la manipulacion de archivos por agentes descontrolados puedan falsificar autoridad.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEvent } from '../../domain/models.ts';

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

export function getEventSignaturePayload(event: MemoryEvent): string {
  const value =
    event.type === 'ASSERT'
      ? event.value
      : event.type === 'SUPERSEDE'
      ? event.new_value
      : event.winning_value;

  return [
    event.id,
    event.entity_key,
    String(event.authority),
    value,
    event.created_at,
  ].join(':');
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
