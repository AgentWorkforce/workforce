import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_TRIGGERS, lintTriggers } from './triggers.js';
import type { PersonaSpec } from './types.js';

const baseRuntime = {
  harness: 'claude' as const,
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
};

function specWithIntegrations(
  integrations: PersonaSpec['integrations']
): PersonaSpec {
  return {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    tiers: {
      best: baseRuntime,
      'best-value': baseRuntime,
      minimum: baseRuntime
    },
    ...(integrations ? { integrations } : {})
  };
}

test('KNOWN_TRIGGERS ships a non-empty list per shipped provider', () => {
  for (const [provider, names] of Object.entries(KNOWN_TRIGGERS)) {
    assert.ok(
      names.length > 0,
      `provider ${provider} must declare at least one known trigger`
    );
    for (const name of names) {
      assert.ok(name.includes('.') || name.includes('_'), `trigger "${name}" should look like an event name`);
    }
  }
});

test('lintTriggers returns no issues for a persona with no integrations', () => {
  assert.deepEqual(lintTriggers(specWithIntegrations(undefined)), []);
});

test('lintTriggers returns no issues for known providers and known triggers', () => {
  const issues = lintTriggers(
    specWithIntegrations({
      github: {
        triggers: [
          { on: 'pull_request.opened' },
          { on: 'issue_comment.created' }
        ]
      },
      linear: { triggers: [{ on: 'issue.created' }] }
    })
  );
  assert.deepEqual(issues, []);
});

test('lintTriggers warns once per unknown provider', () => {
  const issues = lintTriggers(
    specWithIntegrations({
      mysteryapp: { triggers: [{ on: 'thing.opened' }, { on: 'thing.closed' }] }
    })
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warning');
  assert.equal(issues[0].provider, 'mysteryapp');
  assert.equal(issues[0].path, 'integrations.mysteryapp');
});

test('lintTriggers warns per unknown trigger for a known provider', () => {
  const issues = lintTriggers(
    specWithIntegrations({
      github: {
        triggers: [
          { on: 'pull_request.opened' },
          { on: 'pull_request.really_truly_new_event' },
          { on: 'made.up' }
        ]
      }
    })
  );
  const triggers = issues.map((i) => i.trigger).sort();
  assert.deepEqual(triggers, ['made.up', 'pull_request.really_truly_new_event']);
  for (const issue of issues) {
    assert.equal(issue.level, 'warning');
    assert.equal(issue.provider, 'github');
    assert.match(issue.path, /integrations\.github\.triggers\[\d+\]\.on/);
  }
});
