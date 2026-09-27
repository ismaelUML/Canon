// src/domain/security.ts
// Filtro defensivo: jamas almacenar secretos, contrasenas o tokens en Canon.
// Si un agente enloquece e intenta persistir un API key o un password de produccion,
// se rechaza en seco antes de que toque el event log.

const FORBIDDEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,          // Claves privadas RSA/PEM
  /sk-[a-zA-Z0-9_-]{20,}/,                       // OpenAI, Anthropic, etc.
  /AIza[0-9A-Za-z-_]{35}/,                       // Google Cloud API Keys
  /ghp_[a-zA-Z0-9]{36}/,                         // GitHub Personal Access Tokens
  /bearer\s+ey[a-zA-Z0-9_.-]+/i,                 // JWT Bearer tokens
  /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/i // Connection strings con credenciales
];

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

// Complejidad ciclomatica <= 3. Simple, seguro y testeable.
export function validateAssertionSecurity(assertion: string): ValidationResult {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(assertion)) {
      return {
        allowed: false,
        reason: 'Se detecto un posible secreto o credencial sensible en la asercion. Rechazado por politica de privacidad.',
      };
    }
  }
  return { allowed: true };
}
