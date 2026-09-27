// src/adapters/resolver/path_resolver.ts
// Resolucion ascendente de limites de proyecto (Monorepos y Multi-root).
// Busca hacia arriba desde el archivo activo hasta encontrar .canon/ o un boundary marker.
// REGLA CRITICA: Se detiene incondicionalmente en la raiz del repo Git (.git/).
// Jamas cruza el techo de .git/ hacia las carpetas personales del sistema operativo.

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

export function resolveProjectRoot(startPath: string): ResolvedProject {
  let currentDir = resolve(startPath);
  try {
    if (existsSync(currentDir) && !statSync(currentDir).isDirectory()) {
      currentDir = dirname(currentDir);
    }
  } catch {
    currentDir = dirname(currentDir);
  }

  let candidateBoundary: string | null = null;

  while (true) {
    // 1. Si esta carpeta ya tiene su propio .canon/, esa es su raiz indiscutible
    const canonPath = join(currentDir, '.canon');
    if (existsSync(canonPath)) {
      return { rootDir: currentDir, canonDir: canonPath };
    }

    // 2. Si encontramos un marker de subproyecto (ej: package.json en apps/frontend)
    if (!candidateBoundary) {
      for (const marker of BOUNDARY_MARKERS) {
        if (existsSync(join(currentDir, marker))) {
          candidateBoundary = currentDir;
          break;
        }
      }
    }

    // 3. TECHO DURO: Si encontramos .git/, la busqueda frena de inmediato
    const gitPath = join(currentDir, '.git');
    if (existsSync(gitPath)) {
      const chosenRoot = candidateBoundary ?? currentDir;
      return { rootDir: chosenRoot, canonDir: join(chosenRoot, '.canon') };
    }

    const parentDir = dirname(currentDir);
    // Llegamos a la raiz del filesystem (C:\ o /) sin cruzar .git/
    if (parentDir === currentDir) {
      const chosenRoot = candidateBoundary ?? currentDir;
      return { rootDir: chosenRoot, canonDir: join(chosenRoot, '.canon') };
    }

    currentDir = parentDir;
  }
}
