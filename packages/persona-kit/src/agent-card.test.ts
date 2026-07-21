import assert from 'node:assert/strict';
import test from 'node:test';

import { A2aAgentCardSchema } from '@relaycast/a2a';

import { deriveAgentCard } from './agent-card.js';
import type { PersonaSpec } from './types.js';

const options = {
  baseUrl: 'https://review-agent.example.test',
  version: '1.2.3'
};

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'review-agent',
    intent: 'review',
    tags: ['review'],
    description: 'Reviews changes.',
    skills: [
      {
        id: 'review-rubric',
        source: '@agentworkforce/review-rubric',
        description: 'Apply the review rubric.'
      }
    ],
    harness: 'codex',
    model: 'gpt-5',
    systemPrompt: 'Review the change.',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 },
    ...overrides
  };
}

test('deriveAgentCard produces the canonical A2A shape with defaults', () => {
  const card = deriveAgentCard(persona(), options);

  assert.deepEqual(A2aAgentCardSchema.parse(card), card);
  assert.equal(card.name, 'review-agent');
  assert.deepEqual(card.capabilities, {
    streaming: false,
    pushNotifications: false
  });
  assert.deepEqual(card.default_input_modes, [
    'text/plain',
    'application/json'
  ]);
  assert.deepEqual(card.default_output_modes, [
    'text/plain',
    'application/json'
  ]);
  assert.deepEqual(card.provider, {
    organization: 'AgentWorkforce',
    persona_id: 'review-agent',
    intent: 'review',
    tags: ['review']
  });
});

test('deriveAgentCard includes enabled capabilities and omits disabled ones', () => {
  const card = deriveAgentCard(
    persona({
      capabilities: {
        review: true,
        issueClaim: false,
        conflictAutofix: { enabled: false },
        httpRead: { enabled: true, allow: [] }
      }
    }),
    options
  );

  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    ['review-rubric', 'review', 'httpRead']
  );
});

test('deriveAgentCard preserves enabled unknown capabilities', () => {
  const card = deriveAgentCard(
    persona({
      capabilities: {
        teamSolve: { enabled: true, maxMembers: 3 },
        futureCapability: { enabled: false }
      }
    }),
    options
  );

  assert.ok(card.skills.some((skill) => skill.id === 'teamSolve'));
  assert.ok(!card.skills.some((skill) => skill.id === 'futureCapability'));
});

test('deriveAgentCard uses relay.agentName and otherwise falls back to persona id', () => {
  assert.equal(
    deriveAgentCard(persona({ relay: { agentName: 'relay-reviewer' } }), options)
      .name,
    'relay-reviewer'
  );
  assert.equal(deriveAgentCard(persona({ relay: true }), options).name, 'review-agent');
  assert.equal(deriveAgentCard(persona({ relay: {} }), options).name, 'review-agent');
});

test('deriveAgentCard surfaces integration providers as skill tags', () => {
  const card = deriveAgentCard(
    persona({
      integrations: { github: {}, slack: {} },
      capabilities: { review: true }
    }),
    options
  );

  for (const skill of card.skills) {
    assert.ok(skill.tags?.includes('github'));
    assert.ok(skill.tags?.includes('slack'));
  }
  assert.deepEqual(card.skills[0]?.tags, [
    '@agentworkforce/review-rubric',
    'github',
    'slack'
  ]);
});

test('deriveAgentCard canonicalizes pullRequest and derives A2A capability flags', () => {
  const card = deriveAgentCard(
    persona({
      capabilities: {
        review: false,
        pullRequest: true,
        streaming: {},
        pushNotifications: { enabled: false }
      }
    }),
    {
      ...options,
      documentationUrl: 'https://docs.example.test/reviewer',
      inputModes: ['application/json'],
      outputModes: ['text/markdown']
    }
  );

  assert.equal(card.skills.filter((skill) => skill.id === 'review').length, 1);
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false
  });
  assert.deepEqual(card.default_input_modes, ['application/json']);
  assert.deepEqual(card.default_output_modes, ['text/markdown']);
  assert.equal(card.documentation_url, 'https://docs.example.test/reviewer');
});

test('deriveAgentCard uses intent as the schema-required fallback skill', () => {
  const card = deriveAgentCard(persona({ skills: [], capabilities: {} }), options);

  assert.deepEqual(card.skills, [
    {
      id: 'review',
      name: 'Review',
      description: 'Reviews changes.',
      tags: []
    }
  ]);
  assert.deepEqual(A2aAgentCardSchema.parse(card), card);
});
