import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_SKILL_TARGETS,
  HARNESS_VALUES,
  PERSONA_INTENTS,
  listBuiltInPersonas,
  materializeSkills,
  materializeSkillsFor,
  personaCatalog,
  resolvePersona,
  resolvePersonaByTier,
  resolveSidecar,
  routingProfiles,
  usePersona,
  useSelection,
  type PersonaSelection,
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

function syntheticSelection(over: Partial<PersonaSelection> = {}): PersonaSelection {
  const runtime = {
    harness: 'codex' as const,
    model: 'test-model',
    systemPrompt: 'test prompt',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
  };
  return {
    personaId: 'synthetic',
    tier: 'best-value',
    runtime,
    skills: [],
    rationale: 'test',
    ...over
  };
}

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

test('built-in catalog is limited to internal system personas', () => {
  const builtIns = listBuiltInPersonas();
  assert.deepEqual(builtIns.map((p) => p.id).sort(), [
    'nango-function-builder',
    'persona-improver',
    'persona-maker'
  ]);
  assert.equal(personaCatalog['persona-authoring']?.id, 'persona-maker');
  assert.equal(personaCatalog['persona-improvement']?.id, 'persona-improver');
  assert.equal(personaCatalog['nango-function-building']?.id, 'nango-function-builder');
  assert.equal(personaCatalog.review, undefined);
  assert.ok(PERSONA_INTENTS.includes('review'));
  assert.equal(routingProfiles.default.intents.review.tier, 'best-value');
});

test('resolves persona-maker from the default routing profile', () => {
  const selection = resolvePersona('persona-authoring');
  assert.equal(selection.personaId, 'persona-maker');
  assert.equal(selection.tier, 'best');
  assert.equal(selection.runtime.harness, 'codex');
  assert.match(selection.rationale, /balanced-default/);
  assert.equal(selection.inputs?.TARGET_DIR?.default, '.agentworkforce/workforce/personas');
  assert.equal(selection.inputs?.CREATE_MODE?.default, 'local');
  assert.match(selection.agentsMdContent ?? '', /\$TARGET_DIR\/<id>\.json/);
  assert.equal(selection.runtime.harnessSettings.sandboxMode, 'workspace-write');
  assert.equal(selection.runtime.harnessSettings.approvalPolicy, 'on-request');
  assert.equal(selection.runtime.harnessSettings.workspaceWriteNetworkAccess, true);
  assert.match(
    selection.agentsMdContent ?? '',
    /Do not request network escalation only to complete this fallback/
  );
});

test('resolves nango-function-builder from the default routing profile', () => {
  const selection = resolvePersona('nango-function-building');
  assert.equal(selection.personaId, 'nango-function-builder');
  assert.equal(selection.tier, 'best-value');
  assert.equal(selection.runtime.harness, 'codex');
  assert.equal(selection.skills.length, 1);
  assert.equal(selection.skills[0].id, 'building-nango-functions-locally');
  assert.match(selection.skills[0].source, /NangoHQ\/skills#building-nango-functions-locally/);
  assert.match(selection.agentsMdContent ?? '', /NangoHQ\/integration-templates/);
  assert.equal(selection.runtime.harnessSettings.workspaceWriteNetworkAccess, true);
});

test('optional pack-owned intents do not resolve from the built-in catalog', () => {
  assert.throws(
    () => resolvePersona('review'),
    /No built-in persona is registered for intent "review".*personas-core/
  );
  assert.throws(
    () => resolvePersonaByTier('review', 'best'),
    /No built-in persona is registered for intent "review"/
  );
});

test('legacy tier override remains available for internal personas', () => {
  const selection = resolvePersonaByTier('persona-authoring', 'minimum');
  assert.equal(selection.personaId, 'persona-maker');
  assert.equal(selection.tier, 'minimum');
  assert.equal(selection.runtime.harness, 'opencode');
  assert.match(selection.rationale, /legacy-tier-override/);
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

test('materializeSkillsFor derives an install plan from a resolved internal persona', () => {
  const selection = resolvePersona('persona-authoring');
  const plan = materializeSkillsFor(selection);
  assert.equal(plan.harness, 'codex');
  assert.equal(plan.installs.length, 1);
  assert.deepEqual([...plan.installs[0].installCommand], [
    'npx',
    '-y',
    'skills',
    'add',
    'https://github.com/vercel-labs/skills',
    '--skill',
    'find-skills',
    '-y'
  ]);
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

test('useSelection install command never embeds cleanup', () => {
  const context = useSelection(syntheticSelection({ skills: [prpmSkill] }));
  assert.doesNotMatch(context.install.commandString, /rm -rf/);
  assert.match(
    context.install.commandString,
    /prpm install @prpm\/npm-trusted-publishing --as codex/
  );
});

test('useSelection exposes a post-run cleanupCommandString targeting skill artifacts', () => {
  const context = useSelection(syntheticSelection({ skills: [prpmSkill] }));
  assert.ok(Array.isArray(context.install.cleanupCommand));
  assert.equal(context.install.cleanupCommand[0], 'sh');
  assert.match(context.install.cleanupCommandString, /^rm -rf /);
  assert.match(context.install.cleanupCommandString, /npm-trusted-publishing/);
  assert.doesNotMatch(context.install.cleanupCommandString, /prpm\.lock|skills-lock\.json/);
});

test('useSelection cleanupCommandString chains paths from every install in the plan', () => {
  const context = useSelection(
    syntheticSelection({ skills: [skillShSkill, prpmSkill] })
  );
  const cleanup = context.install.cleanupCommandString;
  assert.match(cleanup, /^rm -rf /);
  assert.match(cleanup, /find-skills/);
  assert.match(cleanup, /npm-trusted-publishing/);
  assert.match(cleanup, /\.agents\/skills\/find-skills/);
  assert.match(cleanup, /\.claude\/skills\/find-skills/);
  assert.match(cleanup, /\.factory\/skills\/find-skills/);
  assert.match(cleanup, /\.kiro\/skills\/find-skills/);
});

test('useSelection cleanupCommandString is a shell no-op when the persona declares no skills', () => {
  const context = useSelection(syntheticSelection());
  assert.equal(context.install.cleanupCommandString, ':');
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

test('useSelection with installRoot emits scaffold plus chained prpm', () => {
  const installRoot = '/tmp/agent-workforce/sessions/scaffold-test/claude/plugin';
  const selection = syntheticSelection({ skills: [prpmSkill] });
  const context = useSelection(selection, { harness: 'claude', installRoot });
  assert.equal(context.install.plan.sessionInstallRoot, installRoot);
  const cmd = context.install.commandString;
  assert.match(cmd, /^mkdir -p /);
  assert.match(cmd, /\.claude-plugin/);
  assert.match(cmd, /ln -sfn \.claude\/skills /);
  assert.match(cmd, /printf '%s' /);
  assert.match(cmd, / && cd '?\/tmp\/agent-workforce\/sessions\/scaffold-test\/claude\/plugin'? && /);
  assert.match(cmd, /npx -y prpm install @prpm\/npm-trusted-publishing --as claude/);
});

test('useSelection with installRoot collapses cleanup to a single rm -rf of the stage dir', () => {
  const installRoot = '/tmp/agent-workforce/sessions/cleanup-test/claude/plugin';
  const context = useSelection(
    syntheticSelection({ skills: [prpmSkill] }),
    { harness: 'claude', installRoot }
  );
  assert.equal(
    context.install.cleanupCommandString,
    `rm -rf /tmp/agent-workforce/sessions/cleanup-test/claude/plugin`
  );
});

test('materializeSkills with installRoot and no skills still reports the sessionInstallRoot', () => {
  const installRoot = '/tmp/agent-workforce/sessions/empty/claude/plugin';
  const plan = materializeSkills([], 'claude', { installRoot });
  assert.equal(plan.sessionInstallRoot, installRoot);
  assert.equal(plan.installs.length, 0);
});

test('useSelection with installRoot and no skills emits scaffold so plugin dir exists', () => {
  const installRoot = '/tmp/agent-workforce/sessions/empty-scaffold/claude/plugin';
  const context = useSelection(syntheticSelection(), { harness: 'claude', installRoot });
  assert.equal(context.install.plan.sessionInstallRoot, installRoot);
  assert.equal(context.install.plan.installs.length, 0);
  assert.notEqual(context.install.commandString, ':');
  assert.match(context.install.commandString, /^mkdir -p /);
  assert.equal(context.install.cleanupCommandString, `rm -rf ${installRoot}`);
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

test('usePersona combines selection and grouped install metadata into a frozen context', () => {
  const context = usePersona('persona-authoring');
  const selection = resolvePersona('persona-authoring');
  const plan = materializeSkillsFor(selection);

  assert.deepEqual(context.selection, selection);
  assert.deepEqual(context.install.plan, plan);
  assert.equal(context.install.command[0], 'sh');
  assert.match(context.install.commandString, /skills add/);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.selection));
  assert.ok(Object.isFrozen(context.install));
  assert.ok(Object.isFrozen(context.install.plan));
  assert.ok(Object.isFrozen(context.install.command));
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

test('PersonaSpec accepts an optional defaultTier and the built-in catalog leaves it unset', () => {
  // Surface check on the type and built-in catalog. Local-persona parsing of
  // defaultTier (with bad-value rejection) is covered in local-personas.test.ts.
  const spec = syntheticSpec({ defaultTier: 'best' });
  assert.equal(spec.defaultTier, 'best');
  assert.equal(personaCatalog['persona-authoring']?.defaultTier, undefined);
});

test('resolvePersona populates sidecar selection fields from the internal catalog', () => {
  const sel = resolvePersona('persona-authoring');
  assert.equal(sel.claudeMd, undefined);
  assert.equal(sel.claudeMdContent, undefined);
  assert.equal(sel.claudeMdMode, undefined);
  assert.equal(sel.agentsMd, undefined);
  assert.match(sel.agentsMdContent ?? '', /Persona author/);
  assert.equal(sel.agentsMdMode, 'overwrite');
});
