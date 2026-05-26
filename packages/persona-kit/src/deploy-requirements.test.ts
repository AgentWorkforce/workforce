import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDeployRequirements } from './deploy-requirements.js';
import type { PersonaSpec } from './types.js';

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'p',
    intent: 'review',
    tags: ['review'],
    description: 'd',
    skills: [],
    harness: 'codex',
    model: 'gpt-5',
    systemPrompt: 'handle it',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 600 },
    ...overrides
  };
}

test('integrations: required by default, sorted, triggers extracted', () => {
  const req = deriveDeployRequirements(
    persona({
      integrations: {
        slack: { source: { kind: 'workspace' }, triggers: [{ on: 'message' }] },
        github: { triggers: [{ on: 'issues.opened' }, { on: 'issues.labeled' }] }
      }
    })
  );
  assert.deepEqual(req.integrations.map((i) => i.provider), ['github', 'slack']);
  assert.equal(req.integrations[0].required, true);
  assert.deepEqual(req.integrations[0].triggers, ['issues.opened', 'issues.labeled']);
  assert.deepEqual(req.integrations[1].source, { kind: 'workspace' });
});

test('integrations: optional:true → required:false (non-blocking)', () => {
  const req = deriveDeployRequirements(
    persona({
      integrations: {
        github: { triggers: [{ on: 'issues.opened' }] },
        slack: { optional: true, triggers: [{ on: 'message' }] }
      }
    })
  );
  const slack = req.integrations.find((i) => i.provider === 'slack');
  const github = req.integrations.find((i) => i.provider === 'github');
  assert.equal(slack?.required, false);
  assert.equal(github?.required, true);
});

test('inputs: only prompt for no-default + not-optional', () => {
  const req = deriveDeployRequirements(
    persona({
      inputs: {
        mustAsk: { description: 'needed' },
        hasDefault: { default: 'x' },
        isOptional: { optional: true }
      }
    })
  );
  assert.deepEqual(req.inputs.map((i) => i.name), ['mustAsk']);
  assert.equal(req.inputs[0].required, true);
  assert.equal(req.inputs[0].description, 'needed');
});

test('firesOn: integration triggers + schedules + watch events, de-duped', () => {
  const req = deriveDeployRequirements(
    persona({
      integrations: { github: { triggers: [{ on: 'issues.opened' }] } },
      schedules: [{ name: 'daily', cron: '0 9 * * *' }],
      watch: [{ paths: ['/x'], events: ['created', 'updated'] }]
    })
  );
  assert.deepEqual(req.firesOn, [
    'github:issues.opened',
    'schedule:daily',
    'relayfile:created',
    'relayfile:updated'
  ]);
});

test('platformSecrets: empty for Layer A and (currently) for isolated', () => {
  const p = persona({ integrations: { github: { triggers: [{ on: 'issues.opened' }] } } });
  assert.deepEqual(deriveDeployRequirements(p).platformSecrets, []);
  assert.deepEqual(deriveDeployRequirements(p, { isolated: true }).platformSecrets, []);
});

test('empty persona: no integrations/inputs/firesOn', () => {
  const req = deriveDeployRequirements(persona());
  assert.deepEqual(req.integrations, []);
  assert.deepEqual(req.inputs, []);
  assert.deepEqual(req.firesOn, []);
  assert.deepEqual(req.platformSecrets, []);
});
