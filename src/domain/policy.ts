// src/domain/policy.ts
// Politicas de amortiguacion de conflictos.
// Queremos frenar al agente si toca la base de datos o auth,
// pero que no nos joda la vida si cambia un puerto local temporal.

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
  },
  defaultPolicy: 'soft_lww',
};

// Resuelve la politica comparando prefijos con wildcard simple.
// Complejidad ciclomatica <= 3: solo un loop y un match basico.
export function resolvePolicy(entityKey: string, config: PolicyConfig): ConflictPolicy {
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
