// scripts/audit_metrics.ts
// Auditoria matematica de metricas de diseno de paquetes segun Robert C. Martin (Seccion 2)
// Ca, Ce, I, A y Distancia a la Secuencia Principal (D = |A + I - 1| < 0.70)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageMetricResult {
  packageName: string;
  ca: number; // Acoplamiento Aferente
  ce: number; // Acoplamiento Eferente
  instability: number; // I = Ce / (Ca + Ce)
  abstractCount: number; // Na
  totalClasses: number; // Nc
  abstraction: number; // A = Na / Nc
  distance: number; // D = |A + I - 1|
  passed: boolean;
}

function scanTsFiles(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.git' && entry !== 'dist') {
        scanTsFiles(full, fileList);
      }
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      fileList.push(full);
    }
  }
  return fileList;
}

export function auditPackages(packagesDir: string = 'packages'): PackageMetricResult[] {
  if (!existsSync(packagesDir)) {
    return [];
  }

  const pkgDirs = readdirSync(packagesDir).filter((d) => {
    return statSync(join(packagesDir, d)).isDirectory() && existsSync(join(packagesDir, d, 'package.json'));
  });

  const packageNames = new Map<string, string>(); // dirName -> pkgName
  const packageDeps = new Map<string, Set<string>>(); // pkgName -> Set of depended pkgNames
  const packageFiles = new Map<string, string[]>();

  for (const d of pkgDirs) {
    const pkgJsonPath = join(packagesDir, d, 'package.json');
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const name = pkgJson.name || d;
    packageNames.set(d, name);
    packageDeps.set(name, new Set());
    packageFiles.set(name, scanTsFiles(join(packagesDir, d, 'src')));
  }

  // Analizar imports entre paquetes (regla de conteo logico estricto: dependencias unicas entre paquetes)
  for (const [pkgName, files] of packageFiles.entries()) {
    const depsSet = packageDeps.get(pkgName)!;
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of importMatches) {
        const importPath = m[1];
        for (const [targetDir, targetPkgName] of packageNames.entries()) {
          if (targetPkgName !== pkgName) {
            // Detecta import via nombre de paquete @canon/... o ruta relativa hacia ../otro_paquete
            if (
              importPath.startsWith(targetPkgName) ||
              importPath.includes(`/${targetDir}/`) ||
              importPath.includes(`\\${targetDir}\\`) ||
              importPath.includes(`../${targetDir}`) ||
              importPath.includes(`..\\${targetDir}`)
            ) {
              depsSet.add(targetPkgName);
            }
          }
        }
      }
    }
  }

  const results: PackageMetricResult[] = [];

  for (const [pkgName, files] of packageFiles.entries()) {
    // Ce: Paquetes externos de los que este paquete depende
    const ce = packageDeps.get(pkgName)!.size;

    // Ca: Paquetes externos que dependen de este paquete
    let ca = 0;
    for (const [otherPkg, deps] of packageDeps.entries()) {
      if (otherPkg !== pkgName && deps.has(pkgName)) {
        ca++;
      }
    }

    // Inestabilidad I
    const instability = ca + ce > 0 ? Math.round((ce / (ca + ce)) * 100) / 100 : 0.0;

    // Abstraccion A: interfaces + types abstractos / total classes + types
    let abstractCount = 0;
    let concreteCount = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Abstracciones: interface Foo, type Foo, abstract class Foo
      const interfaces = content.match(/\binterface\s+[A-Za-z0-9_$]+/g) || [];
      const types = content.match(/\btype\s+[A-Za-z0-9_$]+\s*=/g) || [];
      const abstractClasses = content.match(/\babstract\s+class\s+[A-Za-z0-9_$]+/g) || [];
      abstractCount += interfaces.length + types.length + abstractClasses.length;

      // Concretos: class Foo (no abstract), const/function implementaciones
      const classes = (content.match(/\bclass\s+[A-Za-z0-9_$]+/g) || []).filter(
        (c) => !c.startsWith('abstract')
      );
      concreteCount += classes.length;
    }

    const totalClasses = abstractCount + concreteCount;
    const abstraction = totalClasses > 0 ? Math.round((abstractCount / totalClasses) * 100) / 100 : 0.5;

    // Distancia a la secuencia principal: D = |A + I - 1|
    const distance = Math.round(Math.abs(abstraction + instability - 1) * 100) / 100;
    const passed = distance < 0.70;

    results.push({
      packageName: pkgName,
      ca,
      ce,
      instability,
      abstractCount,
      totalClasses,
      abstraction,
      distance,
      passed,
    });
  }

  return results;
}

export function runPackageMetricsAudit(): boolean {
  console.log('='.repeat(80));
  console.log(' AUDITORIA DE METRICAS ESTRUCTURALES DE PAQUETES (ROBERT C. MARTIN)');
  console.log('='.repeat(80));

  const results = auditPackages();
  if (results.length === 0) {
    console.log('⚠️ No se detectaron paquetes en packages/. Requiere partición en Workspaces.');
    return false;
  }

  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? '✅ APROBADO' : '❌ RECHAZADO';
    console.log(`\nPaquete: ${r.packageName}`);
    console.log(`  - Acoplamiento Aferente (Ca): ${r.ca} (Responsabilidad)`);
    console.log(`  - Acoplamiento Eferente (Ce): ${r.ce} (Dependencia Externa)`);
    console.log(`  - Inestabilidad (I): ${r.instability}`);
    console.log(`  - Abstracción (A): ${r.abstraction} (${r.abstractCount}/${r.totalClasses} tipos abstractos)`);
    console.log(`  - Distancia Secuencia Principal (D): ${r.distance} (Umbral < 0.70) -> ${status}`);

    if (!r.passed) {
      allPassed = false;
      if (r.abstraction < 0.3 && r.instability < 0.3) {
        console.log(`    ⚠️ Zona de Dolor (A -> 0, I -> 0): Rigidez excesiva.`);
      } else if (r.abstraction > 0.7 && r.instability > 0.7) {
        console.log(`    ⚠️ Zona de Vacío (A -> 1, I -> 1): Sobreingeniería.`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  if (!allPassed) {
    console.log('ESTADO: RECHAZO ARQUITECTONICO (D >= 0.70 en uno o más paquetes).');
    return false;
  }
  console.log('ESTADO: METRICAS ESTRUCTURALES EN BALANCE EQUILIBRADO (D < 0.70).');
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('audit_metrics.ts')) {
  const passed = runPackageMetricsAudit();
  if (!passed) {
    process.exit(1);
  }
}
