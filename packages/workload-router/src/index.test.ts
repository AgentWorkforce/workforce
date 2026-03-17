import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersona } from './index.js';

test('resolves frontend implementer default tier', () => {
  const result = resolvePersona('implement-frontend');
  assert.equal(result.personaId, 'frontend-implementer');
  assert.equal(result.tier, 'best-value');
  assert.equal(result.runtime.harness, 'opencode');
});

test('resolves reviewer minimum tier', () => {
  const result = resolvePersona('review', 'minimum');
  assert.equal(result.personaId, 'code-reviewer');
  assert.equal(result.runtime.harness, 'opencode');
});

test('resolves architecture best tier to codex high reasoning', () => {
  const result = resolvePersona('architecture-plan', 'best');
  assert.equal(result.runtime.harness, 'codex');
  assert.equal(result.runtime.harnessSettings.reasoning, 'high');
});
