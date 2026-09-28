// src/domain/policy.ts
// Politicas de amortiguacion de conflictos y gobernanza de claves.
// Fail-closed por diseño: namespaces desconocidos interrumpen o se rechazan.

export type ConflictPolicy = 'interrupt' | 'soft_lww' | 'auto_latest';

export interface PolicyConfig {
  rules: Record<string, ConflictPolicy>;
  defaultPolicy: ConflictPolicy;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  rules: {
    'db:*': 'interrupt',
    'security:*': 'interrupt',
    'convention:*': 'soft_lww',
    'dev_local:*': 'auto_latest',
    'dep:*': 'soft_lww',
    'learned:*': 'soft_lww',
  },
  defaultPolicy: 'interrupt', // FAIL-CLOSED: nada desconocido pasa en silencio
};

// Resuelve la politica comparando prefijos con wildcard simple.
export function resolvePolicy(entityKey: string, config: PolicyConfig = DEFAULT_POLICY_CONFIG): ConflictPolicy {
  for (const [pattern, policy] of Object.entries(config.rules)) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (entityKey.startsWith(prefix)) {
        return policy;
      }
    } else if (entityKey === pattern) {
      return policy;
    }
  }
  return config.defaultPolicy;
}

// Verifica si la clave pertenece a un namespace/regla explicita
export function isKeyRegistered(entityKey: string, config: PolicyConfig = DEFAULT_POLICY_CONFIG): boolean {
  for (const pattern of Object.keys(config.rules)) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (entityKey.startsWith(prefix)) {
        return true;
      }
    } else if (entityKey === pattern) {
      return true;
    }
  }
  return false;
}

// Extrae el subsistema de una clave jerarquica (ej: 'convention:git:branch_naming' -> 'convention:git')
export function extractSubsystemAndLeaf(entityKey: string): { subsystem: string; leaf: string; hasSubsystem: boolean } {
  const parts = entityKey.split(':');
  if (parts.length <= 2) {
    return { subsystem: parts[0], leaf: parts[1] ?? parts[0], hasSubsystem: false };
  }
  // Mas de 2 partes: los primeros N-1 son subsistema, el ultimo es la hoja
  const leaf = parts[parts.length - 1];
  const subsystem = parts.slice(0, parts.length - 1).join(':');
  return { subsystem, leaf, hasSubsystem: true };
}
