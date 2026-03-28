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
      },
      'test-strategy': {
        tier: 'best-value',
        rationale: 'needs balanced coverage planning'
      },
      'tdd-enforcement': {
        tier: 'minimum',
        rationale: 'short process reminders are enough'
      },
      'flake-investigation': {
        tier: 'best',
        rationale: 'deep debugging is worth the cost'
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

test('resolves testing personas from the default routing profile', () => {
  const testStrategy = resolvePersona('test-strategy');
  assert.equal(testStrategy.personaId, 'test-strategist');
  assert.equal(testStrategy.tier, 'best-value');

  const tdd = resolvePersona('tdd-enforcement');
  assert.equal(tdd.personaId, 'tdd-guard');
  assert.equal(tdd.tier, 'best-value');

  const flake = resolvePersona('flake-investigation');
  assert.equal(flake.personaId, 'flake-hunter');
  assert.equal(flake.tier, 'best');
  assert.equal(flake.runtime.harness, 'codex');
});
