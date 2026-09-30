// packages/canon_application/src/oracle/repo_oracle.ts
// Oraculo mecanico del repositorio:
// Compara directamente contra package.json del proyecto activo.
// La realidad de disco mata a la memoria con autoridad REPO_ORACLE (90).
// Complejidad ciclomatica <= 5 por funcion garantizada.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventStore, SupersedeEvent, ActiveFact } from '../../../canon_domain/src/index.ts';
import { Authority, fold } from '../../../canon_domain/src/index.ts';

export interface AuditResult {
  checked_keys: number;
  mismatches_found: number;
  superseded_events: string[];
}

export function loadPackageDependencies(projectRoot: string): Record<string, string> | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;

  try {
    const pkgContent = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return {
      ...(pkgContent.dependencies ?? {}),
      ...(pkgContent.devDependencies ?? {}),
    };
  } catch {
    return null;
  }
}

export function createOracleSupersedeEvent(
  entityKey: string,
  fact: ActiveFact,
  realVersion: string
): SupersedeEvent {
  return {
    id: `oracle_${randomUUID()}`,
    entity_key: entityKey,
    logical_ts: 0,
    supersedes_event_id: fact.source_event_id,
    new_value: realVersion,
    authority: Authority.REPO_ORACLE,
    source_session_id: 'oracle_audit',
    created_at: new Date().toISOString(),
    type: 'SUPERSEDE',
  };
}

export function isVersionMismatched(activeFacts: ActiveFact[] | undefined, realVersion: string): boolean {
  if (!activeFacts || activeFacts.length === 0) return false;
  return activeFacts[0].value !== realVersion;
}

export class RepoOracle {
  private store: EventStore;
  private projectRoot: string;

  constructor(store: EventStore, projectRoot: string) {
    this.store = store;
    this.projectRoot = projectRoot;
  }

  async auditPackageJson(signal?: AbortSignal): Promise<AuditResult> {
    const allDeps = loadPackageDependencies(this.projectRoot);
    if (!allDeps) {
      return { checked_keys: 0, mismatches_found: 0, superseded_events: [] };
    }

    const allEvents = await this.store.getAllEvents(signal);
    const projection = fold(allEvents);

    const supersededEvents: string[] = [];
    let checkedKeys = 0;
    let mismatches = 0;

    for (const [depName, realVersion] of Object.entries(allDeps)) {
      checkedKeys++;
      const entityKey = `dep:${depName}:version`;
      const activeFacts = projection.active_facts.get(entityKey);

      if (isVersionMismatched(activeFacts, realVersion)) {
        mismatches++;
        const evt = createOracleSupersedeEvent(entityKey, activeFacts![0], realVersion);
        await this.store.append(evt, signal);
        supersededEvents.push(evt.id);
      }
    }

    return {
      checked_keys: checkedKeys,
      mismatches_found: mismatches,
      superseded_events: supersededEvents,
    };
  }
}
