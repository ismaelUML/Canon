// packages/canon_application/src/resolver/path_resolver.ts
// Resolucion ascendente de limites de proyecto (Monorepos y Multi-root).
// Busca hacia arriba desde el archivo activo hasta encontrar .canon/ o un boundary marker.
// REGLA CRITICA: Se detiene incondicionalmente en la raiz del repo Git (.git/).
// Complejidad ciclomatica <= 5 garantizada en todas las subfunciones.

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BOUNDARY_MARKERS = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
];

export interface ResolvedProject {
  rootDir: string;
  canonDir: string;
}

export function validateAndGetInitialDir(startPath: string): string {
  const safeStart = resolve(startPath);
  if (safeStart.includes('\0')) {
    throw new Error('Path traversal detected: null byte in path');
  }
  try {
    if (existsSync(safeStart) && !statSync(safeStart).isDirectory()) {
      return dirname(safeStart);
    }
  } catch {
    return dirname(safeStart);
  }
  return safeStart;
}

export function findBoundaryMarker(dir: string): string | null {
  for (const marker of BOUNDARY_MARKERS) {
    if (existsSync(join(dir, marker))) {
      return dir;
    }
  }
  return null;
}

export function isTraversalBoundary(currentDir: string, parentDir: string): boolean {
  if (parentDir === currentDir) return true;
  return existsSync(join(currentDir, '.git'));
}

export function resolveProjectRoot(startPath: string): ResolvedProject {
  let currentDir = validateAndGetInitialDir(startPath);
  let candidateBoundary: string | null = null;

  while (true) {
    const localCanon = resolve(currentDir, '.canon');
    if (existsSync(localCanon)) {
      return { rootDir: currentDir, canonDir: localCanon };
    }

    if (!candidateBoundary) {
      candidateBoundary = findBoundaryMarker(currentDir);
    }

    const parentDir = dirname(currentDir);
    if (isTraversalBoundary(currentDir, parentDir)) {
      const chosenRoot = candidateBoundary ?? currentDir;
      return { rootDir: chosenRoot, canonDir: resolve(chosenRoot, '.canon') };
    }

    currentDir = parentDir;
  }
}
