import { resolvePersona, type PersonaIntent, type PersonaTier } from '../packages/workload-router/src/index.js';

type OpenClawSpawnPayload = {
  runtime: 'subagent' | 'acp';
  task: string;
  model?: string;
  thinking?: 'low' | 'medium' | 'high';
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
};

function mapToOpenClawSpawn(
  intent: PersonaIntent,
  tier: PersonaTier,
  task: string,
): OpenClawSpawnPayload {
  const selection = resolvePersona(intent, tier);

  const runtime = selection.runtime.harness === 'codex' ? 'acp' : 'subagent';

  return {
    runtime,
    task,
    model: selection.runtime.model,
    thinking: selection.runtime.harnessSettings.reasoning,
    timeoutSeconds: selection.runtime.harnessSettings.timeoutSeconds,
    metadata: {
      personaId: selection.personaId,
      intent: selection.intent,
      tier: selection.tier,
      systemPrompt: selection.runtime.systemPrompt,
    },
  };
}

// Example usage
const payload = mapToOpenClawSpawn(
  'review',
  'best-value',
  'Review PR #123 for correctness, risk, and missing tests.',
);

console.log(JSON.stringify(payload, null, 2));
