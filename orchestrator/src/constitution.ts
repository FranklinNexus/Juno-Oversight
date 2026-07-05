/**
 * Juno Constitution — long-horizon ambitions (human amends; Juno measures gaps).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface AmbitionMetric {
  id: string;
  description: string;
  /** true when Juno believes metric is satisfied */
  satisfied?: boolean;
  evidence?: string;
}

export interface Ambition {
  id: string;
  statement: string;
  weight: number;
  metrics: AmbitionMetric[];
}

export interface JunoConstitution {
  identity?: string;
  ambitions: Ambition[];
  forbidden?: string[];
  humanRole?: string;
  /** Min tension score (0–1) before auto-queue from drive engine */
  autoQueueThreshold?: number;
}

export interface AmbitionGap {
  ambitionId: string;
  statement: string;
  weight: number;
  openMetrics: AmbitionMetric[];
  gapScore: number;
}

function configPath(workbench: string): string {
  return path.join(workbench, "config", "constitution.json");
}

export function loadConstitution(workbench: string): JunoConstitution | null {
  const p = configPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as JunoConstitution;
  } catch {
    return null;
  }
}

export function computeAmbitionGaps(
  constitution: JunoConstitution,
  evidence: Record<string, { satisfied: boolean; note?: string }> = {},
): AmbitionGap[] {
  const gaps: AmbitionGap[] = [];
  for (const amb of constitution.ambitions) {
    const open: AmbitionMetric[] = [];
    for (const m of amb.metrics) {
      const ext = evidence[`${amb.id}:${m.id}`];
      const ok = ext?.satisfied ?? m.satisfied === true;
      if (!ok) {
        open.push({ ...m, satisfied: false, evidence: ext?.note ?? m.evidence });
      }
    }
    if (open.length === 0) continue;
    const gapScore = (open.length / Math.max(amb.metrics.length, 1)) * amb.weight;
    gaps.push({
      ambitionId: amb.id,
      statement: amb.statement,
      weight: amb.weight,
      openMetrics: open,
      gapScore,
    });
  }
  return gaps.sort((a, b) => b.gapScore - a.gapScore);
}
