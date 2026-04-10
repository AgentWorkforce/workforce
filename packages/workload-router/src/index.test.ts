import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_SKILL_TARGETS,
  HARNESS_VALUES,
  materializeSkills,
  materializeSkillsFor,
  personaCatalog,
  resolvePersona,
  resolvePersonaByTier
} from './index.js';

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
      },
      'opencode-workflow-correctness': {
        tier: 'best',
        rationale: 'cross-layer workflow failures need deeper investigation'
      },
      'workflow-cli-compatibility': {
        tier: 'best',
        rationale: 'provider matrix failures need deeper investigation'
      },
      'npm-provenance': {
        tier: 'best-value',
        rationale: 'mechanical workflow wiring'
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

  const opencodeWorkflow = resolvePersona('opencode-workflow-correctness');
  assert.equal(opencodeWorkflow.personaId, 'opencode-workflow-specialist');
  assert.equal(opencodeWorkflow.tier, 'best');
  assert.equal(opencodeWorkflow.runtime.harness, 'codex');

  const workflowCliCompatibility = resolvePersona('workflow-cli-compatibility');
  assert.equal(workflowCliCompatibility.personaId, 'workflow-cli-compatibility-specialist');
  assert.equal(workflowCliCompatibility.tier, 'best');
  assert.equal(workflowCliCompatibility.runtime.harness, 'codex');
  assert.match(workflowCliCompatibility.runtime.systemPrompt, /Gemini-specific checklist/);
});

test('claude is a recognized harness value', () => {
  assert.ok(HARNESS_VALUES.includes('claude'));
});

test('personas default to an empty skills array when none declared', () => {
  const reviewer = personaCatalog.review;
  assert.ok(Array.isArray(reviewer.skills));
  assert.equal(reviewer.skills.length, 0);
});

test('resolves npm-provenance persona with the trusted publishing skill attached', () => {
  const selection = resolvePersona('npm-provenance');
  assert.equal(selection.personaId, 'npm-provenance-publisher');
  assert.equal(selection.tier, 'best-value');
  assert.equal(selection.skills.length, 1);
  const [skill] = selection.skills;
  assert.equal(skill.id, 'prpm/npm-trusted-publishing');
  assert.match(skill.source, /prpm\.dev\/packages\/prpm\/npm-trusted-publishing/);
  assert.match(selection.runtime.systemPrompt, /prpm\/npm-trusted-publishing/);
});

test('resolvePersonaByTier carries persona skills through legacy path', () => {
  const selection = resolvePersonaByTier('npm-provenance', 'best');
  assert.equal(selection.runtime.harness, 'codex');
  assert.equal(selection.skills[0]?.id, 'prpm/npm-trusted-publishing');
});

test('HARNESS_SKILL_TARGETS covers every harness value', () => {
  for (const harness of HARNESS_VALUES) {
    const target = HARNESS_SKILL_TARGETS[harness];
    assert.ok(target, `missing target for harness ${harness}`);
    assert.ok(target.asFlag.length > 0);
    assert.ok(target.dir.length > 0);
  }
});

test('materializeSkills emits a codex-scoped prpm install for a prpm.dev URL', () => {
  const plan = materializeSkills(
    [
      {
        id: 'prpm/npm-trusted-publishing',
        source: 'https://prpm.dev/packages/prpm/npm-trusted-publishing',
        description: 'trusted publishing skill'
      }
    ],
    'codex'
  );

  assert.equal(plan.harness, 'codex');
  assert.equal(plan.installs.length, 1);
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'prpm');
  assert.equal(install.packageRef, 'prpm/npm-trusted-publishing');
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', 'prpm/npm-trusted-publishing', '--as', 'codex']
  );
  assert.equal(install.installedDir, '.agents/skills/npm-trusted-publishing');
  assert.equal(install.installedManifest, '.agents/skills/npm-trusted-publishing/SKILL.md');
});

test('materializeSkills routes claude skills to .claude/skills via --as claude', () => {
  const plan = materializeSkills(
    [
      {
        id: 'prpm/npm-trusted-publishing',
        source: 'prpm/npm-trusted-publishing',
        description: 'bare ref form'
      }
    ],
    'claude'
  );

  const [install] = plan.installs;
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', 'prpm/npm-trusted-publishing', '--as', 'claude']
  );
  assert.equal(install.installedDir, '.claude/skills/npm-trusted-publishing');
});

test('materializeSkillsFor derives an install plan from a resolved persona', () => {
  const selection = resolvePersona('npm-provenance');
  const plan = materializeSkillsFor(selection);
  assert.equal(plan.harness, selection.runtime.harness);
  assert.equal(plan.installs.length, 1);
  const cmd = plan.installs[0].installCommand.join(' ');
  assert.match(cmd, /prpm install prpm\/npm-trusted-publishing --as /);
});

test('materializeSkills rejects unknown skill sources', () => {
  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'x',
            source: 'https://example.com/random',
            description: 'not a prpm source'
          }
        ],
        'claude'
      ),
    /Unsupported skill source/
  );
});

test('materializeSkills handles personas with no skills', () => {
  const plan = materializeSkills([], 'claude');
  assert.equal(plan.installs.length, 0);
});
