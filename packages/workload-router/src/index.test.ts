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
      'requirements-analysis': {
        tier: 'minimum',
        rationale: 'quick scope triage is enough here'
      },
      debugging: {
        tier: 'best',
        rationale: 'debugging still needs deeper reasoning'
      },
      'security-review': {
        tier: 'best',
        rationale: 'security stays on the strongest tier'
      },
      documentation: {
        tier: 'minimum',
        rationale: 'docs tweaks can be short'
      },
      verification: {
        tier: 'best-value',
        rationale: 'fresh evidence review needs balanced depth'
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


test('resolves newly added personas from the default routing profile', () => {
  const analyst = resolvePersona('requirements-analysis');
  assert.equal(analyst.personaId, 'requirements-analyst');
  assert.equal(analyst.tier, 'best-value');

  const debuggerSelection = resolvePersona('debugging');
  assert.equal(debuggerSelection.personaId, 'debugger');
  assert.equal(debuggerSelection.tier, 'best');
  assert.equal(debuggerSelection.runtime.harness, 'codex');

  const security = resolvePersona('security-review');
  assert.equal(security.personaId, 'security-reviewer');
  assert.equal(security.tier, 'best');

  const docs = resolvePersona('documentation');
  assert.equal(docs.personaId, 'technical-writer');
  assert.equal(docs.tier, 'best-value');

  const verification = resolvePersona('verification');
  assert.equal(verification.personaId, 'verifier');
  assert.equal(verification.tier, 'best-value');
});
