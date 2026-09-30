// scripts/sqale_audit.ts
// Modelo Financiero de Deuda Tecnica y Friccion Operativa (SQALE extendido + Capers Jones)
// Cuantifica en horas y dolares el pasivo tecnico, friccion F(MI), CNHN y ROI de refactorizacion.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeFile } from './check_complexity.ts';
import { auditPackages } from './audit_metrics.ts';

// Parametros calibrados para JavaScript / TypeScript segun Seccion 4.4
const TS_CONFIG = {
  CC_UMBRAL: 7,
  K_HOURS: 0.35, // 21 min por punto de CCE
  CDU_HOURS: 0.40, // 24 min por LOC de desarrollo
  FF_BASE: 0.10,
  FF_MAX: 0.25,
  ALPHA_BASE: 1.0,
  DEFAULT_HOURLY_RATE: 65, // USD/hora integrado
  T_BASE_BACKEND: 7.0, // Horas base para intervencion backend sobre codigo limpio
};

export interface SqaleFinancialReport {
  loc: number;
  avgMi: number;
  operationalFrictionFactor: number; // F(MI)
  pureFrictionHoursPerYear: number;
  assetValueUsd: number; // VA
  remediationCostUsd: number; // CR
  technicalDebtRatio: number; // TDR (%)
  costOfDoingNothingUsd: number; // CNHN
  opportunityCostUsd: number; // CO
  roiPercentage: number; // ROI (%)
}

function scanAllTs(dirs: string[]): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          if (!['node_modules', '.git', '.canon', 'dist', 'coverage'].includes(entry)) {
            walk(full);
          }
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
          files.push(full);
        }
      }
    } catch {}
  }
  for (const d of dirs) walk(d);
  return files;
}

export function runSqaleAudit(dirs: string[] = ['packages', 'src'], hourlyRate: number = TS_CONFIG.DEFAULT_HOURLY_RATE): SqaleFinancialReport {
  console.log('='.repeat(80));
  console.log(' AUDITORIA FINANCIERA DE DEUDA TECNICA SQALE + FRICCION OPERATIVA (CAPERS JONES)');
  console.log('='.repeat(80));

  const files = scanAllTs(dirs);
  let totalLoc = 0;
  let totalCce = 0;
  let miSum = 0;

  for (const file of files) {
    const report = analyzeFile(file);
    totalLoc += report.totalLoc;
    miSum += report.mi;
    for (const v of report.violations) {
      if (v.cc > TS_CONFIG.CC_UMBRAL) {
        totalCce += v.cc - TS_CONFIG.CC_UMBRAL;
      }
    }
  }

  const avgMi = files.length > 0 ? Math.round((miSum / files.length) * 10) / 10 : 85;

  // 1. Friccion Operativa Dinamica F(MI)
  const gapMi = Math.max(0, (75 - avgMi) / 75);
  const fMi = Math.round((1 + gapMi * 3) * 100) / 100;
  const tReal = TS_CONFIG.T_BASE_BACKEND * fMi;
  const pureFrictionPerHour = tReal - TS_CONFIG.T_BASE_BACKEND;
  const pureFrictionHoursPerYear = Math.round(pureFrictionPerHour * 10 * 10) / 10; // 10 intervenciones/ano

  // 2. Valoracion de Activo y Pasivo (SQALE Fases A y B)
  const va = Math.round(totalLoc * TS_CONFIG.CDU_HOURS * hourlyRate);
  const cr = Math.round(totalCce * TS_CONFIG.K_HOURS * hourlyRate);
  const tdr = va > 0 ? Math.round((cr / va) * 10000) / 100 : 0.0;

  // 3. Proyeccion Sistemica (SQALE Fase C)
  const packageMetrics = auditPackages();
  const avgCa = packageMetrics.length > 0 ? packageMetrics.reduce((s, p) => s + p.ca, 0) / packageMetrics.length : 1;
  const avgI = packageMetrics.length > 0 ? packageMetrics.reduce((s, p) => s + p.instability, 0) / packageMetrics.length : 0.5;
  const avgA = packageMetrics.length > 0 ? packageMetrics.reduce((s, p) => s + p.abstraction, 0) / packageMetrics.length : 0.5;
  const avgD = packageMetrics.length > 0 ? packageMetrics.reduce((s, p) => s + p.distance, 0) / packageMetrics.length : 0.2;

  const ff = TS_CONFIG.FF_BASE + (TS_CONFIG.FF_MAX * (avgCa / (avgCa + 1)));
  const alphaAdaptativo = TS_CONFIG.ALPHA_BASE + ((1.0 - avgI) * (1.0 - avgA));
  const co = Math.round((totalCce * TS_CONFIG.K_HOURS * hourlyRate * (alphaAdaptativo - 1)) * (1.0 + avgD));
  const cnhn = Math.round((cr * ff) + co);
  const roi = cr > 0 ? Math.round((cnhn / cr) * 100) : 0;

  console.log(`\n1. INVENTARIO DE CODIGO Y SALUD BASAL:`);
  console.log(`   - Líneas Lógicas Ejecutables (LOC): ${totalLoc}`);
  console.log(`   - Índice de Mantenibilidad Promedio (MI): ${avgMi}/100 ${avgMi >= 85 ? '(🏆 Dorado)' : avgMi >= 75 ? '(✅ Verde)' : '(⚠️ Fricción)'}`);
  console.log(`   - Complejidad Ciclomática Excedente (CCE): ${totalCce} puntos sobre umbral (${TS_CONFIG.CC_UMBRAL})`);

  console.log(`\n2. FRICCION OPERATIVA DINAMICA F(MI) (Capers Jones / Stripe Benchmark):`);
  console.log(`   - Multiplicador de Fricción F(MI): ${fMi}x`);
  console.log(`   - Tiempo de Intervención Backend Real: ${Math.round(tReal * 10) / 10} h (Base limpio: ${TS_CONFIG.T_BASE_BACKEND} h)`);
  console.log(`   - Desperdicio por Fricción Pura: ${pureFrictionHoursPerYear} horas/año por desarrollador`);

  console.log(`\n3. BALANCE FINANCIERO DEL ACTIVO (SQALE):`);
  console.log(`   - Valor de Reemplazo del Activo (VA): $${va.toLocaleString()} USD`);
  console.log(`   - Costo de Reparación Inmediata de Deuda (CR): $${cr.toLocaleString()} USD (${Math.round(totalCce * TS_CONFIG.K_HOURS * 10) / 10} h técnico)`);
  console.log(`   - Ratio de Deuda Técnica (TDR): ${tdr}% (Límite SonarCloud Gate < 5.0%)`);

  console.log(`\n4. COSTO DE NO HACER NADA (CNHN) Y RETORNO DE INVERSION (ROI):`);
  console.log(`   - Factor de Fricción Sistémica (FF): ${Math.round(ff * 100) / 100} (Amplificación por acoplamiento Ca=${Math.round(avgCa * 10) / 10})`);
  console.log(`   - Costo de Oportunidad por Releases Demorados (CO): $${co.toLocaleString()} USD`);
  console.log(`   - Costo Anual de Inacción (CNHN): $${cnhn.toLocaleString()} USD`);
  if (cr > 0) {
    console.log(`   - Retorno de Inversión en Refactorización (ROI): ${roi}% anual`);
  } else {
    console.log(`   - Deuda Técnica Cero: Código en régimen de máxima rentabilidad.`);
  }

  console.log('\n' + '='.repeat(80));
  return {
    loc: totalLoc,
    avgMi,
    operationalFrictionFactor: fMi,
    pureFrictionHoursPerYear,
    assetValueUsd: va,
    remediationCostUsd: cr,
    technicalDebtRatio: tdr,
    costOfDoingNothingUsd: cnhn,
    opportunityCostUsd: co,
    roiPercentage: roi,
  };
}

if (process.argv[1] && process.argv[1].endsWith('sqale_audit.ts')) {
  runSqaleAudit();
}
