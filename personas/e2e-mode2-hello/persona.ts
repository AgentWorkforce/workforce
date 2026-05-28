import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Minimal Mode 2 persona (single-agent handler).
 *
 * Trigger: a GitHub issue is opened or labeled on AgentWorkforce/cloud.
 * Action:  if the issue carries the `hello` label, the handler posts a
 *          single comment back acknowledging the Mode 2 handler ran.
 *
 * Exists to prove the Mode 2 path (proactive trigger -> single agent.ts
 * handler -> back-channel write) end-to-end with the smallest possible
 * persona — no clone, no shell, no workflow, no runtime work.
 */
export default definePersona({
  id: 'e2e-mode2-hello',
  intent: 'review',
  tags: ['review'],
  description:
    'Minimal Mode 2 E2E probe: replies to AgentWorkforce/cloud issues labeled `hello` with a single confirmation comment, to prove the single-agent handler path runs end-to-end.',
  cloud: true,
  onEvent: './agent.ts',
  harness: 'codex',
  model: 'gpt-5',
  systemPrompt: 'Handle the proactive event.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  integrations: {
    github: {
      source: { kind: 'workspace' },
      triggers: [
        { on: 'issues.opened' },
        { on: 'issues.labeled' }
      ]
    }
  }
});
