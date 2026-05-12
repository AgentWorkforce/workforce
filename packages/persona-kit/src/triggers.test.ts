import test from 'node:test';
import assert from 'node:assert/strict';

import { KNOWN_TRIGGERS, lintTriggers } from './triggers.js';
import type { PersonaSpec } from './types.js';

const runtime = {
  harness: 'claude',
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
} as const;

function persona(integrations: PersonaSpec['integrations']): PersonaSpec {
  return {
    id: 'trigger-test',
    intent: 'review',
    tags: ['review'],
    description: 'lint triggers',
    skills: [],
    tiers: { best: runtime, 'best-value': runtime, minimum: runtime },
    integrations
  };
}

test('KNOWN_TRIGGERS includes at least eight trigger names for every tier-1 provider', () => {
  for (const [provider, triggers] of Object.entries(KNOWN_TRIGGERS)) {
    assert.ok(
      triggers.length >= 8,
      `${provider} should expose at least eight known trigger names`
    );
  }
});

test('lintTriggers accepts deploy-v1 example trigger names', () => {
  const issues = lintTriggers(
    persona({
      github: {
        triggers: [
          { on: 'pull_request.opened' },
          { on: 'issue_comment.created', match: '@mention' },
          { on: 'pull_request_review_comment.created' },
          { on: 'check_run.completed', where: 'conclusion=failure' }
        ]
      },
      linear: { triggers: [{ on: 'issue.created' }] },
      slack: { triggers: [{ on: 'app_mention' }] },
      notion: { triggers: [{ on: 'page.updated' }] },
      jira: { triggers: [{ on: 'issue.created' }] }
    })
  );

  assert.deepEqual(issues, []);
});

test('lintTriggers warns for unknown providers and trigger names without throwing', () => {
  const issues = lintTriggers(
    persona({
      github: { triggers: [{ on: 'pull_request.opened' }, { on: 'pull_request.evaporated' }] },
      mystery: { triggers: [{ on: 'thing.happened' }] }
    })
  );

  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.provider, issue.trigger, issue.path]),
    [
      ['unknown_trigger', 'github', 'pull_request.evaporated', 'integrations.github.triggers[1].on'],
      ['unknown_provider', 'mystery', undefined, 'integrations.mystery']
    ]
  );
});
