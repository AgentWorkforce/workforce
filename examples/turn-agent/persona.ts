import { defineTurnPersona } from '@agentworkforce/turn-kit';

export default defineTurnPersona({
  id: 'turn-agent-example',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Minimal multi-turn Relay chat agent built with turn-kit.',
  cloud: true,
  sandbox: false,
  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Answer clearly and briefly, using the supplied conversation history.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },
  relay: { inbox: ['@self'] },
  onEvent: './agent.ts'
});
