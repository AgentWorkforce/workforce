import { resolvePersona } from '../packages/workload-router/src/index.js';
import type { PersonaIntent } from '../packages/persona-kit/src/index.js';

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

  const runtime = selection.harness === 'codex' ? 'acp' : 'subagent';

  return {
    runtime,
    task,
    model: selection.model,
    thinking: selection.harnessSettings.reasoning,
    timeoutSeconds: selection.harnessSettings.timeoutSeconds,
    metadata: {
      personaId: selection.personaId,
      rationale: selection.rationale,
      systemPrompt: selection.systemPrompt
    }
  };
}

// Example usage
const payload = mapToOpenClawSpawn(
  'persona-authoring',
  'Create a persona for reviewing PRs for correctness, risk, and missing tests.'
);

console.log(JSON.stringify(payload, null, 2));
