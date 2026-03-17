import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersona, resolvePersonaByTier } from './index.js';

test('resolves frontend implementer from default routing profile', () => {
  const result = resolvePersona('implement-frontend');
  assert.equal(result.personaId, 'frontend-implementer');
  assert.equal(result.tier, 'best-value');
  assert.equal(result.runtime.harness, 'opencode');
  assert.match(result.rationale, /balanced-default/);
});

test('resolves review from custom routing profile rule', () => {
  const result = resolvePersona('review', {
    id: 'fast-review',
    description: 'Aggressive low-cost mode for lightweight checks',
    intents: {
      'implement-frontend': {
        tier: 'minimum',
        rationale: 'fast and cheap'
      },
      review: {
        tier: 'minimum',
        rationale: 'small PR sanity checks only'
      },
      'architecture-plan': {
        tier: 'best-value',
        rationale: 'still needs decent quality'
      }
    }
  });

  assert.equal(result.personaId, 'code-reviewer');
  assert.equal(result.tier, 'minimum');
  assert.equal(result.runtime.harness, 'opencode');
});

test('legacy tier override remains available via resolvePersonaByTier', () => {
  const result = resolvePersonaByTier('architecture-plan', 'best');
  assert.equal(result.runtime.harness, 'codex');
  assert.equal(result.runtime.harnessSettings.reasoning, 'high');
  assert.match(result.rationale, /legacy-tier-override/);
});
