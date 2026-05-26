import test from 'node:test';
import assert from 'node:assert/strict';

import { definePersona, parsePersonaSpec } from './index.js';

test('definePersona returns authored specs that parse successfully', () => {
  const persona = definePersona({
    id: 'typed-author',
    intent: 'review',
    description: 'Typed authoring fixture.',
    inputs: {
      TOPIC: 'pull requests',
      TARGET_REPO: {
        description: 'Repository to inspect.',
        default: 'AgentWorkforce/workforce'
      }
    },
    integrations: {
      github: {
        triggers: [
          { on: 'pull_request.opened' },
          { on: 'off_registry.github_event' }
        ]
      },
      linear: { triggers: [{ on: 'issue.create' }] },
      slack: { triggers: [{ on: 'message.created' }] },
      confluence: { triggers: [{ on: 'page.updated' }] },
      jira: { triggers: [{ on: 'comment.created' }] },
      customProvider: { triggers: [{ on: 'custom.event' }] }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
  });

  const parsed = parsePersonaSpec(persona, 'review');

  assert.equal(parsed.id, 'typed-author');
  assert.equal(parsed.skills.length, 0);
  assert.equal(parsed.inputs?.TOPIC.default, 'pull requests');
  assert.equal(
    parsed.integrations?.github.triggers?.[1].on,
    'off_registry.github_event'
  );
  assert.equal(parsed.integrations?.customProvider.triggers?.[0].on, 'custom.event');
});

test('definePersona types tags against the closed PersonaTag vocabulary', () => {
  const persona = definePersona({
    id: 'tagged',
    intent: 'review',
    description: 'Tag typing fixture.',
    tags: ['documentation', 'review'],
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
  assert.deepEqual([...(persona.tags ?? [])], ['documentation', 'review']);

  definePersona({
    id: 'bad-tag',
    intent: 'review',
    description: 'An off-vocabulary tag must be a compile error, not a deploy-time 400.',
    // @ts-expect-error 'proactive' is not a PersonaTag (cloud rejects it with 400 invalid_persona)
    tags: ['proactive'],
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
});

test('definePersona type allows interactive personas without onEvent', () => {
  const persona = definePersona({
    id: 'interactive-author',
    intent: 'documentation',
    description: 'Interactive authoring fixture.',
    harness: 'codex',
    model: 'gpt-5.4',
    systemPrompt: 'Write accurate docs.',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 120 }
  });

  assert.equal(persona.harness, 'codex');
});
