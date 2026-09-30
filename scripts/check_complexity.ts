// scripts/check_complexity.ts
// Verificador determinista de Complejidad Ciclomatica (CC <= 5) e Indice de Mantenibilidad (MI >= 75)
// Sin dependencias externas: ejecuta directamente sobre Node 24.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

interface FunctionMetric {
  name: string;
  line: number;
  cc: number;
  loc: number;
}

interface FileReport {
  filePath: string;
  totalLoc: number;
  maxCc: number;
  avgCc: number;
  mi: number;
  violations: FunctionMetric[];
}

const CC_THRESHOLD = 5;
const MI_THRESHOLD = 75;

export function calculateCyclomaticComplexity(functionCode: string): number {
  // Puntos de bifurcacion: if, for, while, catch, case, &&, ||, ternario ?
  // Limpiamos strings y comentarios para evitar falsos positivos
  const sanitized = functionCode
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/(["'`])(?:(?=(\\?))\2[\s\S])*?\1/g, '""');

  let branches = 0;

  // Bifurcaciones de control
  const ifMatches = sanitized.match(/\bif\b/g);
  if (ifMatches) branches += ifMatches.length;

  const forMatches = sanitized.match(/\bfor\b/g);
  if (forMatches) branches += forMatches.length;

  const whileMatches = sanitized.match(/\bwhile\b/g);
  if (whileMatches) branches += whileMatches.length;

  const catchMatches = sanitized.match(/\bcatch\b/g);
  if (catchMatches) branches += catchMatches.length;

  const caseMatches = sanitized.match(/\bcase\b\s+[^:]+:/g);
  if (caseMatches) branches += caseMatches.length;

  // Operadores logicos
  const andMatches = sanitized.match(/&&/g);
  if (andMatches) branches += andMatches.length;

  const orMatches = sanitized.match(/\|\|/g);
  if (orMatches) branches += orMatches.length;

  // Operador ternario (evitando ?., ?? y tipos TypeScript como string?)
  const ternaryMatches = sanitized.match(/(?<!\?)\?(?!\.|\?|:)/g);
  if (ternaryMatches) branches += ternaryMatches.length;

  return branches + 1;
}

export function calculateMI(loc: number, cc: number): number {
  if (loc <= 0) return 100;
  const rawMi = (171 - 5.2 * Math.log(loc) - 0.23 * cc) / 171 * 100;
  return Math.max(0, Math.min(100, Math.round(rawMi * 100) / 100));
}

export function analyzeFile(filePath: string): FileReport {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const logicalLoc = lines.filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
  }).length;

  const functions: FunctionMetric[] = [];

  // Detector de bloques de funcion por llaves balanceadas
  // Identifica: function foo, async function foo, method(), get/set, foo = (...) =>
  const RESERVED_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);
  const funcPattern = /(?<![\w\.])(?:(?:async\s+)?function\s+([a-zA-Z0-9_$]+)|(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{|const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^{]+)?=>\s*\{)/g;

  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(content)) !== null) {
    const rawName = match[1] || match[2] || match[3] || 'anonymous';
    if (RESERVED_WORDS.has(rawName)) continue;
    const funcName = rawName;
    const startIndex = match.index;
    const lineNumber = content.substring(0, startIndex).split('\n').length;

    // Encontrar la llave de apertura
    const openBraceIndex = content.indexOf('{', startIndex);
    if (openBraceIndex === -1) continue;

    // Buscar la llave de cierre correspondiente
    let depth = 1;
    let curr = openBraceIndex + 1;
    while (curr < content.length && depth > 0) {
      const char = content[curr];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      curr++;
    }

    if (depth === 0) {
      const funcBody = content.substring(openBraceIndex, curr);
      const cc = calculateCyclomaticComplexity(funcBody);
      const funcLoc = funcBody.split('\n').length;
      functions.push({
        name: funcName,
        line: lineNumber,
        cc,
        loc: funcLoc,
      });
    }
  }

  const maxCc = functions.reduce((max, f) => Math.max(max, f.cc), functions.length > 0 ? 0 : 1);
  const avgCc = functions.length > 0 ? Math.round((functions.reduce((s, f) => s + f.cc, 0) / functions.length) * 10) / 10 : 1;
  const mi = calculateMI(logicalLoc, maxCc);
  const violations = functions.filter((f) => f.cc > CC_THRESHOLD);

  return {
    filePath,
    totalLoc: logicalLoc,
    maxCc,
    avgCc,
    mi,
    violations,
  };
}

function scanDir(dir: string, fileList: string[] = []): string[] {
  if (!dir) return fileList;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry !== 'node_modules' && entry !== '.git' && entry !== '.canon' && entry !== 'dist' && entry !== 'coverage') {
          scanDir(fullPath, fileList);
        }
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        fileList.push(fullPath);
      }
    }
  } catch {}
  return fileList;
}

export function runComplexityAudit(targetDirs: string[]): boolean {
  console.log('='.repeat(80));
  console.log(' AUDITORIA DETERMINISTA DE COMPLEJIDAD CICLOMATICA (CC <= 5) Y MI (>= 75)');
  console.log('='.repeat(80));

  const allFiles: string[] = [];
  for (const dir of targetDirs) {
    scanDir(dir, allFiles);
  }

  let totalViolations = 0;
  let filesAnalyzed = 0;
  let filesFailingMI = 0;

  for (const file of allFiles) {
    const report = analyzeFile(file);
    filesAnalyzed++;
    const rel = relative(process.cwd(), file);

    const isMiFailing = report.mi < MI_THRESHOLD;
    if (isMiFailing) filesFailingMI++;

    if (report.violations.length > 0 || isMiFailing) {
      console.log(`\n❌ [${rel}] - LOC: ${report.totalLoc}, Max CC: ${report.maxCc}, Avg CC: ${report.avgCc}, MI: ${report.mi}`);
      if (isMiFailing) {
        console.log(`   ⚠️ ALERTA MI: Índice de Mantenibilidad (${report.mi}) por debajo del umbral mínimo (75).`);
      }
      for (const v of report.violations) {
        totalViolations++;
        console.log(`   - Función '${v.name}' (Línea ${v.line}): CC = ${v.cc} (Exceso: +${v.cc - CC_THRESHOLD}) [LOC: ${v.loc}]`);
      }
    } else {
      console.log(`✅ [${rel}] - Max CC: ${report.maxCc}, Avg CC: ${report.avgCc}, MI: ${report.mi}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`RESUMEN: ${filesAnalyzed} archivos auditados.`);
  console.log(`- Funciones con CC > 5: ${totalViolations}`);
  console.log(`- Archivos con MI < 75: ${filesFailingMI}`);

  if (totalViolations > 0 || filesFailingMI > 0) {
    console.log(`ESTADO: RECHAZO ARQUITECTONICO INMEDIATO (Sección 3 & 10 DoD).`);
    return false;
  }

  console.log(`ESTADO: CALIDAD DETERMINISTA APROBADA (Quality Gate: PASSED).`);
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('check_complexity.ts')) {
  const dirs = process.argv.slice(2);
  const targetDirs = dirs.length > 0 ? dirs : ['packages'];
  const passed = runComplexityAudit(targetDirs);
  if (!passed) {
    process.exit(1);
  }
}
