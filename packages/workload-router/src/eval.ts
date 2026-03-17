import type { PersonaIntent, PersonaTier } from './index.js';

export interface EvalCase {
  id: string;
  intent: PersonaIntent;
  prompt: string;
  expectedSignals: string[];
}

export interface EvalResult {
  caseId: string;
  tier: PersonaTier;
  score: number; // 0-100
  costUsd?: number;
  latencyMs?: number;
  notes?: string;
}

/**
 * Placeholder for a future benchmark runner that executes persona/tier combinations
 * and computes quality/cost/latency tradeoffs.
 */
export function summarizeEval(results: readonly EvalResult[]): {
  avgScore: number;
  avgCostUsd: number;
  avgLatencyMs: number;
} {
  if (!results.length) {
    return { avgScore: 0, avgCostUsd: 0, avgLatencyMs: 0 };
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgCostUsd =
    results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / results.length;
  const avgLatencyMs =
    results.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / results.length;

  return { avgScore, avgCostUsd, avgLatencyMs };
}
