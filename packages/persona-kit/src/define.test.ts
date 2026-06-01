import test from 'node:test';
import assert from 'node:assert/strict';

import { definePersona, parsePersonaSpec, type TypedTriggerMap } from './index.js';

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
    // Personas declare integration *connections* only — event triggers moved
    // to the agent (defineAgent). Connection config = source + scope.
    integrations: {
      github: { scope: { repo: 'AgentWorkforce/workforce' } },
      linear: {},
      slack: {},
      confluence: {},
      jira: {},
      customProvider: {}
    },
    capabilities: {
      review: true,
      conflictAutofix: { enabled: false }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
  });

  const parsed = parsePersonaSpec(persona, 'review');

  assert.equal(parsed.id, 'typed-author');
  assert.equal(parsed.skills.length, 0);
  assert.equal(parsed.inputs?.TOPIC.default, 'pull requests');
  assert.equal(parsed.integrations?.github.scope?.repo, 'AgentWorkforce/workforce');
  assert.equal(parsed.integrations?.customProvider.source?.kind, 'deployer_user');
  assert.deepEqual(parsed.capabilities, {
    review: true,
    conflictAutofix: { enabled: false }
  });
});

test('TypedTriggerMap gives per-provider event autocomplete; arbitrary providers fall back to string', () => {
  // Known providers type `on` against their catalog (off-registry strings are
  // still allowed via `string & {}`); unknown providers accept any string.
  const triggers: TypedTriggerMap = {
    github: [
      { on: 'pull_request.opened' },
      { on: 'off_registry.github_event' }
    ],
    linear: [{ on: 'issue.create' }],
    slack: [{ on: 'message.created' }],
    customProvider: [{ on: 'custom.event' }]
  };
  assert.equal(triggers.github?.[1]?.on, 'off_registry.github_event');
  assert.equal(triggers.customProvider?.[0]?.on, 'custom.event');
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
