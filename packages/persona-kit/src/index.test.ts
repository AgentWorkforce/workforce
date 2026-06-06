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
  return {
    id: 's',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    harness: 'claude',
    model: 'claude-3-5-sonnet',
    systemPrompt: 'base',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    ...over
  };
}

test('PERSONA_INTENTS includes the unrouted "review" intent for pack consumers', () => {
  assert.ok(PERSONA_INTENTS.includes('review'));
});

test('claude is a recognized harness value', () => {
  assert.ok(HARNESS_VALUES.includes('claude'));
});

test('grok is a recognized harness value', () => {
  assert.ok(HARNESS_VALUES.includes('grok'));
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

test('materializeSkills routes grok skills to .grok/skills via --as grok', () => {
  const plan = materializeSkills([prpmSkill], 'grok');
  const [install] = plan.installs;
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', '@prpm/npm-trusted-publishing', '--as', 'grok']
  );
  assert.equal(install.installedDir, '.grok/skills/npm-trusted-publishing');
  assert.equal(install.installedManifest, '.grok/skills/npm-trusted-publishing/SKILL.md');
  assert.deepEqual([...install.cleanupPaths], ['.grok/skills/npm-trusted-publishing']);
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
      '.grok/skills/find-skills',
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

const localSkill = {
  id: 'local/essay-authoring',
  source: '.agentworkforce/workforce/skills/essay-authoring.md',
  description: 'repo-local SKILL.md'
};

test('materializeSkills emits a mkdir+cp install for a local .md source', () => {
  const plan = materializeSkills([localSkill], 'claude');

  assert.equal(plan.installs.length, 1);
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'local');
  assert.equal(install.packageRef, '.agentworkforce/workforce/skills/essay-authoring.md');
  assert.equal(install.installedDir, '.claude/skills/essay-authoring');
  assert.equal(install.installedManifest, '.claude/skills/essay-authoring/SKILL.md');
  assert.deepEqual([...install.cleanupPaths], ['.claude/skills/essay-authoring']);
  assert.deepEqual([...install.installCommand], [
    'sh',
    '-c',
    'mkdir -p .claude/skills/essay-authoring && cp .agentworkforce/workforce/skills/essay-authoring.md .claude/skills/essay-authoring/SKILL.md'
  ]);
});

test('local sources accept ./-prefixed and absolute paths and strip the .md extension for the installed name', () => {
  const plan = materializeSkills(
    [
      { id: 'dot-slash', source: './skills/dot-slash.md', description: 'leading ./' },
      { id: 'abs', source: '/abs/path/abs-skill.md', description: 'absolute path' }
    ],
    'codex'
  );
  assert.equal(plan.installs[0].installedDir, '.agents/skills/dot-slash');
  assert.equal(plan.installs[1].installedDir, '.agents/skills/abs-skill');
  assert.match(plan.installs[1].installCommand[2] ?? '', / \/abs\/path\/abs-skill\.md /);
});

test('local sources using SKILL.md adopt the parent dir name as the installed name', () => {
  const plan = materializeSkills(
    [
      {
        id: 'my-skill',
        source: '.agentworkforce/workforce/skills/my-skill/SKILL.md',
        description: 'directory-shaped local skill'
      }
    ],
    'claude'
  );
  const [install] = plan.installs;
  assert.equal(install.installedDir, '.claude/skills/my-skill');
});

test('local source with repoRoot absoluteifies the cp source path', () => {
  const plan = materializeSkills([localSkill], 'claude', {
    repoRoot: '/home/user/project'
  });
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'local');
  assert.equal(plan.repoRoot, '/home/user/project');
  assert.match(
    install.installCommand[2] ?? '',
    /cp \/home\/user\/project\/\.agentworkforce\/workforce\/skills\/essay-authoring\.md /
  );
});

test('local source absolute path is left alone even with repoRoot', () => {
  const plan = materializeSkills(
    [{ id: 'abs', source: '/abs/path/foo.md', description: 'absolute' }],
    'claude',
    { repoRoot: '/home/user/project' }
  );
  const script = plan.installs[0].installCommand[2] ?? '';
  assert.match(script, / \/abs\/path\/foo\.md /);
  assert.ok(!script.includes('/home/user/project/abs/path'));
});

test('local source survives installRoot session mode by embedding the absolute repo path', () => {
  const installRoot = '/tmp/agent-workforce/sessions/local-test/claude/plugin';
  const plan = materializeSkills([localSkill], 'claude', {
    installRoot,
    repoRoot: '/home/user/project'
  });
  const [install] = plan.installs;
  assert.equal(install.installCommand[0], 'sh');
  assert.equal(install.installCommand[1], '-c');
  const script = install.installCommand[2] ?? '';
  // Outer wrapper: cd <installRoot> && <inner>; inner is the sh -c mkdir+cp.
  assert.match(script, /^cd /);
  assert.match(script, /\/local-test\/claude\/plugin/);
  assert.match(script, /\/home\/user\/project\/\.agentworkforce\/workforce\/skills\/essay-authoring\.md/);
  // Per-skill cleanupPaths stay empty in session mode (cleaned via stage dir).
  assert.deepEqual([...install.cleanupPaths], []);
});

test('local source does NOT shadow prpm bare references like coreyhaines31/marketingskills', () => {
  // The local provider is registered first; it must only claim sources that
  // look like local .md paths. A bare prpm <scope>/<name> ref must still go
  // to the prpm provider.
  const plan = materializeSkills(
    [
      {
        id: 'bare-prpm',
        source: 'coreyhaines31/marketingskills',
        description: 'prpm bare ref'
      }
    ],
    'claude'
  );
  assert.equal(plan.installs[0].sourceKind, 'prpm');
});

test('local source rejects paths without .md suffix', () => {
  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'dir',
            source: './skills/my-skill',
            description: 'no .md suffix'
          }
        ],
        'claude'
      ),
    /Unsupported skill source/
  );
});

test('resolveSidecar: path + mode pass through directly from the spec', () => {
  const spec = syntheticSpec({
    claudeMd: '/abs/top.md',
    claudeMdMode: 'extend'
  });
  const resolved = resolveSidecar(spec);
  assert.equal(resolved.claudeMd, '/abs/top.md');
  assert.equal(resolved.claudeMdMode, 'extend');
});

test('resolveSidecar: defaults claudeMdMode to overwrite and surfaces inlined content', () => {
  const spec = syntheticSpec({
    claudeMdContent: '# inlined\n'
  });
  const resolved = resolveSidecar(spec);
  assert.equal(resolved.claudeMdContent, '# inlined\n');
  assert.equal(resolved.claudeMd, undefined);
  assert.equal(resolved.claudeMdMode, 'overwrite');
});
