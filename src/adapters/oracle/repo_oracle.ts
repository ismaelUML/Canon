// src/adapters/oracle/repo_oracle.ts
// Oraculo mecanico del repositorio:
// En vez de adivinar si la memoria esta vieja con un LLM, compara directamente
// contra el archivo package.json u otros configs del proyecto.
// Si package.json dice tailwindcss 4.0.0 y Canon decia 3.4.0, la realidad del disco
// mata a la memoria con autoridad REPO_ORACLE (90).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '../../ports/event_store.ts';
import type { SupersedeEvent } from '../../domain/models.ts';
import { Authority } from '../../domain/models.ts';
import { fold } from '../../domain/fold.ts';

export interface AuditResult {
  checked_keys: number;
  mismatches_found: number;
  superseded_events: string[];
}

export class RepoOracle {
  private store: EventStore;
  private projectRoot: string;

  constructor(store: EventStore, projectRoot: string) {
    this.store = store;
    this.projectRoot = projectRoot;
  }

  async auditPackageJson(): Promise<AuditResult> {
    const pkgPath = join(this.projectRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      return { checked_keys: 0, mismatches_found: 0, superseded_events: [] };
    }

    let pkgContent: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkgContent = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      // Si el JSON esta roto por un merge conflict, no explotamos
      return { checked_keys: 0, mismatches_found: 0, superseded_events: [] };
    }

    const allDeps = {
      ...(pkgContent.dependencies ?? {}),
      ...(pkgContent.devDependencies ?? {}),
    };

    const allEvents = await this.store.getAllEvents();
    const projection = fold(allEvents);

    const supersededEvents: string[] = [];
    let checkedKeys = 0;
    let mismatches = 0;

    for (const [depName, realVersion] of Object.entries(allDeps)) {
      const entityKey = `dep:${depName}:version`;
      checkedKeys++;

      const activeFacts = projection.active_facts.get(entityKey);
      if (!activeFacts || activeFacts.length === 0) {
        continue;
      }

      const currentFact = activeFacts[0];
      // Si la version guardada no coincide con el disco, el disco tiene la verdad
      if (currentFact.value !== realVersion) {
        mismatches++;
        const supersedeEvent: SupersedeEvent = {
          id: `oracle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          entity_key: entityKey,
          supersedes_event_id: currentFact.source_event_id,
          new_value: realVersion,
          authority: Authority.REPO_ORACLE,
          source_session_id: 'oracle_audit',
          created_at: new Date().toISOString(),
          type: 'SUPERSEDE',
        };
        await this.store.append(supersedeEvent);
        supersededEvents.push(supersedeEvent.id);
      }
    }

    return {
      checked_keys: checkedKeys,
      mismatches_found: mismatches,
      superseded_events: supersededEvents,
    };
  }
}
