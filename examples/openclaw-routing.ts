import { resolvePersona, type PersonaIntent } from '../packages/workload-router/src/index.js';

type OpenClawSpawnPayload = {
  runtime: 'subagent' | 'acp';
  task: string;
  model?: string;
  thinking?: 'low' | 'medium' | 'high';
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
};

function mapToOpenClawSpawn(intent: PersonaIntent, task: string): OpenClawSpawnPayload {
  const selection = resolvePersona(intent);

  const runtime = selection.runtime.harness === 'codex' ? 'acp' : 'subagent';

  return {
    runtime,
    task,
    model: selection.runtime.model,
    thinking: selection.runtime.harnessSettings.reasoning,
    timeoutSeconds: selection.runtime.harnessSettings.timeoutSeconds,
    metadata: {
      personaId: selection.personaId,
      tier: selection.tier,
      rationale: selection.rationale,
      systemPrompt: selection.runtime.systemPrompt
    }
  };
}

// Example usage
const payload = mapToOpenClawSpawn(
  'review',
  'Review PR #123 for correctness, risk, and missing tests.'
);

console.log(JSON.stringify(payload, null, 2));
