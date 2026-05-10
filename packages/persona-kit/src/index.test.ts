import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_SKILL_TARGETS,
  HARNESS_VALUES,
  PERSONA_INTENTS,
  materializeSkills,
  resolveSidecar,
  type PersonaSpec
} from './index.js';

const prpmSkill = {
  id: 'prpm/npm-trusted-publishing',
  source: '@prpm/npm-trusted-publishing',
  description: 'trusted publishing skill'
};

const skillShSkill = {
  id: 'skill.sh/find-skills',
  source: 'https://github.com/vercel-labs/skills#find-skills',
  description: 'skill.sh discovery skill'
};

function syntheticSpec(over: Partial<PersonaSpec> = {}): PersonaSpec {
  const baseRuntime = {
    harness: 'claude' as const,
    model: 'claude-3-5-sonnet',
    systemPrompt: 'base',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
  };
  return {
    id: 's',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    tiers: { best: baseRuntime, 'best-value': baseRuntime, minimum: baseRuntime },
    ...over
  };
}

test('PERSONA_INTENTS includes the unrouted "review" intent for pack consumers', () => {
  assert.ok(PERSONA_INTENTS.includes('review'));
});

test('claude is a recognized harness value', () => {
  assert.ok(HARNESS_VALUES.includes('claude'));
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
        ...prpmSkill,
        source: 'https://prpm.dev/packages/@prpm/npm-trusted-publishing'
      }
    ],
    'codex'
  );

  assert.equal(plan.harness, 'codex');
  assert.equal(plan.installs.length, 1);
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'prpm');
  assert.equal(install.packageRef, '@prpm/npm-trusted-publishing');
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', '@prpm/npm-trusted-publishing', '--as', 'codex']
  );
  assert.equal(install.installedDir, '.agents/skills/npm-trusted-publishing');
  assert.equal(install.installedManifest, '.agents/skills/npm-trusted-publishing/SKILL.md');
});

test('materializeSkills routes claude skills to .claude/skills via --as claude', () => {
  const plan = materializeSkills([prpmSkill], 'claude');
  const [install] = plan.installs;
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', '@prpm/npm-trusted-publishing', '--as', 'claude']
  );
  assert.equal(install.installedDir, '.claude/skills/npm-trusted-publishing');
});

test('materializeSkills emits a skill.sh install for a github#skill source', () => {
  const plan = materializeSkills([skillShSkill], 'claude');

  assert.equal(plan.installs.length, 1);
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'skill.sh');
  assert.equal(install.packageRef, 'https://github.com/vercel-labs/skills#find-skills');
  assert.deepEqual(
    [...install.installCommand],
    [
      'npx',
      '-y',
      'skills',
      'add',
      'https://github.com/vercel-labs/skills',
      '--skill',
      'find-skills',
      '-y'
    ]
  );
  assert.equal(install.installedDir, '.agents/skills/find-skills');
  assert.equal(install.installedManifest, '.agents/skills/find-skills/SKILL.md');
  assert.deepEqual(
    [...install.cleanupPaths],
    [
      '.agents/skills/find-skills',
      '.claude/skills/find-skills',
      '.factory/skills/find-skills',
      '.kiro/skills/find-skills',
      'skills/find-skills'
    ]
  );
  assert.ok(!install.cleanupPaths.includes('skills-lock.json'));
});

test('materializeSkills accepts GitHub tree URLs for skill.sh skill directories', () => {
  const plan = materializeSkills(
    [
      {
        id: 'nextjs-anti-patterns',
        source: 'https://github.com/wsimmonds/claude-nextjs-skills/tree/main/nextjs-anti-patterns',
        description: 'Next.js anti-pattern guidance'
      },
      {
        id: 'lighthouse-ci-integrator',
        source: 'https://github.com/Dexploarer/hyper-forge/tree/main/.claude/skills/lighthouse-ci-integrator',
        description: 'Lighthouse CI guidance'
      }
    ],
    'opencode'
  );

  assert.deepEqual(
    plan.installs.map((install) => ({
      packageRef: install.packageRef,
      installedDir: install.installedDir,
      command: [...install.installCommand]
    })),
    [
      {
        packageRef: 'https://github.com/wsimmonds/claude-nextjs-skills/tree/main#nextjs-anti-patterns',
        installedDir: '.agents/skills/nextjs-anti-patterns',
        command: [
          'npx',
          '-y',
          'skills',
          'add',
          'https://github.com/wsimmonds/claude-nextjs-skills/tree/main',
          '--skill',
          'nextjs-anti-patterns',
          '-y'
        ]
      },
      {
        packageRef: 'https://github.com/Dexploarer/hyper-forge/tree/main#lighthouse-ci-integrator',
        installedDir: '.agents/skills/lighthouse-ci-integrator',
        command: [
          'npx',
          '-y',
          'skills',
          'add',
          'https://github.com/Dexploarer/hyper-forge/tree/main',
          '--skill',
          'lighthouse-ci-integrator',
          '-y'
        ]
      }
    ]
  );
});

test('materializeSkills rejects unsafe skill.sh skill names', () => {
  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'unsafe',
            source: 'https://github.com/example/skills#../unsafe',
            description: 'unsafe fragment'
          }
        ],
        'opencode'
      ),
    /Unsupported skill source/
  );

  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'unsafe',
            source: 'https://github.com/example/skills/tree/main/.hidden',
            description: 'unsafe tree leaf'
          }
        ],
        'opencode'
      ),
    /Unsupported skill source/
  );
});

test('prpm installs carry a harness-scoped cleanup path, not the lockfile', () => {
  const plan = materializeSkills([prpmSkill], 'codex');
  const [install] = plan.installs;
  assert.deepEqual([...install.cleanupPaths], ['.agents/skills/npm-trusted-publishing']);
  assert.ok(!install.cleanupPaths.includes('prpm.lock'));
});

test('materializeSkills with installRoot stages claude skills under the stage dir', () => {
  const installRoot = '/tmp/agent-workforce/sessions/test-run/claude/plugin';
  const plan = materializeSkills([prpmSkill], 'claude', { installRoot });

  assert.equal(plan.sessionInstallRoot, installRoot);
  const [install] = plan.installs;
  assert.equal(
    install.installedDir,
    `${installRoot}/.claude/skills/npm-trusted-publishing`
  );
  assert.equal(
    install.installedManifest,
    `${installRoot}/.claude/skills/npm-trusted-publishing/SKILL.md`
  );
  assert.equal(install.installCommand[0], 'sh');
  assert.equal(install.installCommand[1], '-c');
  const script = install.installCommand[2];
  assert.match(script, /^cd /);
  assert.match(script, /agent-workforce\/sessions\/test-run\/claude\/plugin/);
  assert.match(script, /npx -y prpm install @prpm\/npm-trusted-publishing --as claude/);
  assert.deepEqual([...install.cleanupPaths], []);
});

test('materializeSkills rejects installRoot for non-claude harnesses', () => {
  assert.throws(
    () =>
      materializeSkills([prpmSkill], 'codex', {
        installRoot: '/tmp/agent-workforce/sessions/abc/claude/plugin'
      }),
    /installRoot is only supported for the claude harness/
  );
});

test('materializeSkills with installRoot and no skills still reports the sessionInstallRoot', () => {
  const installRoot = '/tmp/agent-workforce/sessions/empty/claude/plugin';
  const plan = materializeSkills([], 'claude', { installRoot });
  assert.equal(plan.sessionInstallRoot, installRoot);
  assert.equal(plan.installs.length, 0);
});

test('materializeSkills rejects unknown skill sources', () => {
  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'x',
            source: 'https://example.com/random',
            description: 'not a supported source'
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

test('resolveSidecar: tier path override drops top-level inlined content for the same channel', () => {
  const spec = syntheticSpec({
    claudeMdContent: '# top-level inlined\n',
    claudeMdMode: 'overwrite',
    tiers: {
      best: {
        ...syntheticSpec().tiers.best,
        claudeMd: '/abs/persona.md'
      },
      'best-value': syntheticSpec().tiers['best-value'],
      minimum: syntheticSpec().tiers.minimum
    }
  });
  const resolved = resolveSidecar(spec, 'best');
  assert.equal(resolved.claudeMd, '/abs/persona.md');
  assert.equal(resolved.claudeMdContent, undefined);
  assert.equal(resolved.claudeMdMode, 'overwrite');
});

test('resolveSidecar: mode cascades independently of path', () => {
  const spec = syntheticSpec({
    claudeMd: '/abs/top.md',
    claudeMdMode: 'extend'
  });
  const resolved = resolveSidecar(spec, 'best');
  assert.equal(resolved.claudeMd, '/abs/top.md');
  assert.equal(resolved.claudeMdMode, 'extend');
});

test('PersonaSpec accepts an optional defaultTier', () => {
  const spec = syntheticSpec({ defaultTier: 'best' });
  assert.equal(spec.defaultTier, 'best');
});
