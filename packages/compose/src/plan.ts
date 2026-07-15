import type { ComposePlanV1, ComposeRef, TeamSpec } from './types.js';
import { loadTeamSpec } from './team-spec.js';

/** Pure TeamSpec planner used by preview mode; it never launches child Runs. */
export function planTeamSpec(input: unknown, ref?: ComposeRef): ComposePlanV1 {
  const spec = loadTeamSpec(input);
  const composeRef: ComposeRef = ref ?? { kind: 'team', ref: spec.id };
  if (composeRef.kind !== 'team') throw new Error('planTeamSpec requires a team ComposeRef');
  const nodes: ComposePlanV1['nodes'] = [];
  if (!spec.members.some((member) => member.name === spec.lead)) {
    nodes.push({ id: spec.lead, kind: 'lead' });
  }
  for (const member of spec.members) {
    nodes.push({
      id: member.name,
      kind: member.name === spec.lead ? 'lead' : 'member',
      persona: member.persona,
      ...(member.role ? { role: member.role } : {}),
      ...(member.owns ? { owns: member.owns } : {})
    });
  }
  return {
    schemaVersion: 1,
    composeId: spec.id,
    kind: 'team',
    ref: composeRef,
    status: 'valid',
    nodes,
    edges: spec.members
      .filter((member) => member.name !== spec.lead)
      .map((member) => ({ from: spec.lead, to: member.name, kind: 'delegates' as const })),
    ...((spec.tokenBudget !== undefined || spec.timeBudgetSeconds !== undefined) ? {
      budget: {
        ...(spec.tokenBudget !== undefined ? { tokenBudget: spec.tokenBudget } : {}),
        ...(spec.timeBudgetSeconds !== undefined ? { timeBudgetSeconds: spec.timeBudgetSeconds } : {})
      }
    } : {}),
    errors: []
  };
}

export function createComposePreviewResult(plan: ComposePlanV1) {
  return {
    schemaVersion: 1 as const,
    composeId: plan.composeId,
    status: 'previewed' as const,
    plan,
    childRunIds: []
  };
}
