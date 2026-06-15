import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HARNESS_VALUES,
  isHarness,
  isIntent,
  parseAgentSpec,
  parsePersonaSpec
} from './spec.js';

function validSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    ...over
  };
}

test('spec entrypoint re-exports the validation surface', () => {
  assert.equal(typeof parsePersonaSpec, 'function');
  assert.equal(typeof parseAgentSpec, 'function');
  assert.equal(typeof isIntent, 'function');
  assert.equal(typeof isHarness, 'function');
  assert.ok(Array.isArray(HARNESS_VALUES));
});

test('spec entrypoint validates a minimal persona spec', () => {
  const spec = parsePersonaSpec(validSpec(), 'documentation');
  assert.equal(spec.id, 'p');
  assert.equal(spec.intent, 'documentation');
});

test('spec entrypoint accepts the grok harness', () => {
  assert.ok(HARNESS_VALUES.includes('grok'));
  const spec = parsePersonaSpec(validSpec({ harness: 'grok' }), 'documentation');
  assert.equal(spec.harness, 'grok');
});

test('spec entrypoint parses an agent spec', () => {
  const agent = parseAgentSpec({}, 'agent');
  assert.equal(typeof agent, 'object');
});
