export type Harness = 'opencode' | 'codex';

export type TaskType =
  | 'lint'
  | 'test-triage'
  | 'docs'
  | 'minor-fix'
  | 'feature'
  | 'bugfix'
  | 'refactor-scoped'
  | 'architecture'
  | 'protocol'
  | 'security'
  | 'migration'
  | 'pr-review'
  | 'audit'
  | 'risk-assessment';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface Lane {
  id: string;
  harness: Harness;
  models: string[];
  allowed: TaskType[];
}

export const lanes: Record<string, Lane> = {
  qaCheap: {
    id: 'qa-cheap',
    harness: 'opencode',
    models: ['opencode/mimo-v2-flash-free', 'opencode/minimax-m2.5-free'],
    allowed: ['lint', 'test-triage', 'docs', 'minor-fix']
  },
  implMid: {
    id: 'impl-mid',
    harness: 'opencode',
    models: ['opencode/gpt-5-nano'],
    allowed: ['feature', 'bugfix', 'refactor-scoped']
  },
  architectureHigh: {
    id: 'architecture-high',
    harness: 'codex',
    models: ['openai-codex/gpt-5.3-codex'],
    allowed: ['architecture', 'protocol', 'security', 'migration']
  },
  reviewAudit: {
    id: 'review-audit',
    harness: 'codex',
    models: ['openai-codex/gpt-5.3-codex'],
    allowed: ['pr-review', 'audit', 'risk-assessment']
  }
};

export function routeWorkload(taskType: TaskType, risk: RiskLevel = 'low'): Lane {
  if (risk === 'high' || ['architecture', 'protocol', 'security', 'migration'].includes(taskType)) {
    return lanes.architectureHigh;
  }

  if (['pr-review', 'audit', 'risk-assessment'].includes(taskType)) {
    return lanes.reviewAudit;
  }

  if (['lint', 'test-triage', 'docs', 'minor-fix'].includes(taskType)) {
    return lanes.qaCheap;
  }

  return lanes.implMid;
}
