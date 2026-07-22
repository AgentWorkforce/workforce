import assert from 'node:assert/strict';
import test from 'node:test';

import { A2aAgentCardSchema } from '@relaycast/a2a';

import { getAgentCardTool } from './get-agent-card.js';

const persona = {
  id: 'team-reviewer',
  intent: 'review',
  description: 'Reviews changes with a team.',
  tags: ['review'],
  skills: [
    {
      id: 'review-rubric',
      source: '@agentworkforce/review-rubric',
      description: 'Apply the review rubric.'
    }
  ],
  integrations: { github: {} },
  capabilities: {
    review: true,
    teamSolve: { enabled: true, maxMembers: 2 },
    issueClaim: false
  },
  relay: { agentName: 'relay-team-reviewer' },
  harness: 'codex',
  model: 'gpt-5',
  systemPrompt: 'Review the change.',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 }
};

test('getAgentCardTool parses the persona and returns the canonical card', () => {
  const card = getAgentCardTool({
    persona,
    baseUrl: 'https://agent.example.test',
    version: '2.1.0'
  });

  assert.deepEqual(A2aAgentCardSchema.parse(card), card);
  assert.equal(card.name, 'relay-team-reviewer');
  assert.ok(card.skills.some((skill) => skill.id === 'review-rubric'));
  assert.ok(card.skills.some((skill) => skill.id === 'review'));
  assert.ok(card.skills.some((skill) => skill.id === 'teamSolve'));
  assert.ok(!card.skills.some((skill) => skill.id === 'issueClaim'));
  assert.ok(card.skills.every((skill) => skill.tags?.includes('github')));
});

test('getAgentCardTool rejects unparsed persona input', () => {
  assert.throws(
    () =>
      getAgentCardTool({
        persona: { id: 'broken', intent: 'not-an-intent' },
        baseUrl: 'https://agent.example.test',
        version: '1.0.0'
      }),
    /persona\.intent must be a valid persona intent/
  );
});
