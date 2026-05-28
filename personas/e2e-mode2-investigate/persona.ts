import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Mode 2 investigation persona.
 *
 * Trigger: a GitHub issue is labeled on AgentWorkforce/cloud.
 * Action:  if the issue carries the `investigate` label, the codex harness
 *          reads the materialized repo, produces a 3-5 paragraph diagnosis,
 *          and posts it as a single comment on the issue.
 *
 * Sibling of e2e-mode2-hello — same Mode 2 path, but proves the harness +
 * sandbox + writeback chain on something more substantive than a fixed
 * confirmation string.
 */
export default definePersona({
  id: 'e2e-mode2-investigate',
  intent: 'debugging',
  tags: ['debugging'],
  description:
    'Mode 2 E2E investigation probe: triggers on issues labeled `investigate`, uses the codex harness to read repo code + analyze the issue, then posts a substantive diagnosis comment.',
  cloud: true,
  onEvent: './agent.ts',
  harness: 'codex',
  model: 'gpt-5',
  systemPrompt:
    'You are an investigation agent. Given a GitHub issue, read relevant repo code and post a substantive, well-grounded analysis comment.',
  harnessSettings: {
    reasoning: 'medium',
    timeoutSeconds: 600,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  },
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
