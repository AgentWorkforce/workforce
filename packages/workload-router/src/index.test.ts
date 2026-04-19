import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HARNESS_SKILL_TARGETS,
  HARNESS_VALUES,
  PersonaExecutionError,
  materializeSkills,
  materializeSkillsFor,
  personaCatalog,
  resolvePersona,
  resolvePersonaByTier,
  usePersona,
  useSelection
} from './index.js';

function writeNodeExecutable(dir: string, name: string, source: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function buildEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    ...extra
  };
}

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
      'npm-provenance': {
        tier: 'best-value',
        rationale: 'mechanical workflow wiring'
      },
      'cloud-sandbox-infra': {
        tier: 'best',
        rationale: 'infra changes need deep reasoning'
      },
      'sage-slack-egress-migration': {
        tier: 'best-value',
        rationale: 'migration wiring can use the balanced default'
      },
      'sage-proactive-rewire': {
        tier: 'best-value',
        rationale: 'rewiring work is configuration-heavy rather than max-depth by default'
      },
      'cloud-slack-proxy-guard': {
        tier: 'best-value',
        rationale: 'proxy guard checks usually fit the balanced default tier'
      },
      'sage-cloud-e2e-conduction': {
        tier: 'best-value',
        rationale: 'e2e conduction benefits from strong reasoning without the highest-cost default'
      },
      'capability-discovery': {
        tier: 'best-value',
        rationale: 'lightweight discovery work'
      },
      posthog: {
        tier: 'best-value',
        rationale: 'analytics lookups via MCP'
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

test('resolvePersona propagates env, mcpServers, and permissions to the selection', () => {
  // posthog is the library's canonical carrier for all three optional fields:
  // env.POSTHOG_API_KEY, mcpServers.posthog (http transport with bearer
  // header), and permissions.allow auto-approving posthog MCP tools.
  const selection = resolvePersona('posthog');
  assert.equal(selection.personaId, 'posthog');

  // env is exposed on the selection and still holds the literal $VAR form —
  // interpolation is the runner's job, not resolvePersona's.
  assert.equal(selection.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');

  // mcpServers carry through including headers (runner interpolates later).
  const posthogServer = selection.mcpServers?.posthog;
  assert.ok(posthogServer, 'expected mcpServers.posthog on the selection');
  assert.equal(posthogServer.type, 'http');
  if (posthogServer.type === 'http') {
    assert.equal(posthogServer.url, 'https://mcp.posthog.com/mcp');
    assert.equal(
      posthogServer.headers?.Authorization,
      'Bearer ${POSTHOG_API_KEY}'
    );
  }

  // permissions.allow is carried without modification.
  assert.deepEqual(selection.permissions?.allow, ['mcp__posthog']);
});

test('resolvePersonaByTier also propagates env / mcpServers / permissions', () => {
  const selection = resolvePersonaByTier('posthog', 'minimum');
  assert.equal(selection.tier, 'minimum');
  assert.ok(selection.env, 'env should flow through tier override resolver');
  assert.ok(selection.mcpServers, 'mcpServers should flow through tier override resolver');
  assert.ok(selection.permissions, 'permissions should flow through tier override resolver');
});

test('personas with no optional fields keep them undefined on the selection', () => {
  // code-reviewer has no env/mcpServers/permissions in its JSON.
  const selection = resolvePersona('review');
  assert.equal(selection.env, undefined);
  assert.equal(selection.mcpServers, undefined);
  assert.equal(selection.permissions, undefined);
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
  assert.match(skill.source, /prpm\.dev\/packages\/@prpm\/npm-trusted-publishing/);
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
        source: 'https://prpm.dev/packages/@prpm/npm-trusted-publishing',
        description: 'trusted publishing skill'
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
  const plan = materializeSkills(
    [
      {
        id: 'prpm/npm-trusted-publishing',
        source: '@prpm/npm-trusted-publishing',
        description: 'bare ref form'
      }
    ],
    'claude'
  );

  const [install] = plan.installs;
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'prpm', 'install', '@prpm/npm-trusted-publishing', '--as', 'claude']
  );
  assert.equal(install.installedDir, '.claude/skills/npm-trusted-publishing');
});

test('materializeSkillsFor derives an install plan from a resolved persona', () => {
  const selection = resolvePersona('npm-provenance');
  const plan = materializeSkillsFor(selection);
  assert.equal(plan.harness, selection.runtime.harness);
  assert.equal(plan.installs.length, 1);
  const cmd = plan.installs[0].installCommand.join(' ');
  assert.match(cmd, /prpm install @prpm\/npm-trusted-publishing --as /);
});

test('materializeSkills emits a skill.sh install for a github#skill source', () => {
  const plan = materializeSkills(
    [
      {
        id: 'skill.sh/find-skills',
        source: 'https://github.com/vercel-labs/skills#find-skills',
        description: 'skill.sh discovery skill'
      }
    ],
    'claude'
  );

  assert.equal(plan.installs.length, 1);
  const [install] = plan.installs;
  assert.equal(install.sourceKind, 'skill.sh');
  assert.equal(install.packageRef, 'https://github.com/vercel-labs/skills#find-skills');
  assert.deepEqual(
    [...install.installCommand],
    ['npx', '-y', 'skills', 'add', 'https://github.com/vercel-labs/skills', '--skill', 'find-skills', '-y']
  );
  // skill.sh uses a single universal content dir regardless of harness.
  assert.equal(install.installedDir, '.agents/skills/find-skills');
  assert.equal(install.installedManifest, '.agents/skills/find-skills/SKILL.md');
  // Cleanup should target every harness symlink + the universal dir, but
  // never the lockfile itself.
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

test('prpm installs carry a harness-scoped cleanup path (not the lockfile)', () => {
  const plan = materializeSkills(
    [
      {
        id: 'prpm/npm-trusted-publishing',
        source: '@prpm/npm-trusted-publishing',
        description: 'bare ref form'
      }
    ],
    'codex'
  );
  const [install] = plan.installs;
  assert.deepEqual([...install.cleanupPaths], ['.agents/skills/npm-trusted-publishing']);
  assert.ok(!install.cleanupPaths.includes('prpm.lock'));
});

test('usePersona install command never embeds cleanup (agent must read skills first)', () => {
  // Regression guard: previously buildInstallArtifacts inlined `&& rm -rf` into
  // the install step, which ran BEFORE the agent step and deleted skill files
  // the agent needed to read. Cleanup now lives on a separate post-agent step
  // and on install.cleanupCommandString for Mode B callers.
  const context = usePersona('npm-provenance');
  assert.doesNotMatch(context.install.commandString, /rm -rf/);
  assert.match(
    context.install.commandString,
    /prpm install @prpm\/npm-trusted-publishing --as [a-z]+/
  );
});

test('usePersona exposes a post-run cleanupCommandString targeting skill artifact paths', () => {
  const context = usePersona('npm-provenance');
  assert.ok(Array.isArray(context.install.cleanupCommand));
  assert.equal(context.install.cleanupCommand[0], 'sh');
  assert.match(context.install.cleanupCommandString, /^rm -rf /);
  assert.match(context.install.cleanupCommandString, /npm-trusted-publishing/);
  // The provider lockfile must never be cleaned — repeat runs depend on it.
  assert.doesNotMatch(context.install.cleanupCommandString, /prpm\.lock|skills-lock\.json/);
});

test('usePersona cleanupCommandString chains paths from every install in the plan', () => {
  const context = usePersona('capability-discovery');
  const cleanup = context.install.cleanupCommandString;
  // Both the skill.sh symlink set and the prpm per-harness dir should appear
  // in a single rm -rf chain.
  assert.match(cleanup, /^rm -rf /);
  assert.match(cleanup, /find-skills/);
  assert.match(cleanup, /self-improving/);
  // Cover every skill.sh harness symlink, not just the universal dir.
  assert.match(cleanup, /\.agents\/skills\/find-skills/);
  assert.match(cleanup, /\.claude\/skills\/find-skills/);
  assert.match(cleanup, /\.factory\/skills\/find-skills/);
  assert.match(cleanup, /\.kiro\/skills\/find-skills/);
});

test('usePersona cleanupCommandString is a shell no-op when the persona declares no skills', () => {
  const context = usePersona('architecture-plan');
  assert.equal(context.install.cleanupCommandString, ':');
});

test('materializeSkills with installRoot stages claude skills under the stage dir', () => {
  const installRoot = '/tmp/agent-workforce/sessions/test-run/claude/plugin';
  const plan = materializeSkills(
    [
      {
        id: 'prpm/npm-trusted-publishing',
        source: '@prpm/npm-trusted-publishing',
        description: 'bare ref form'
      }
    ],
    'claude',
    { installRoot }
  );

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
  // Per-install command is self-contained: runs prpm inside the stage dir.
  assert.equal(install.installCommand[0], 'sh');
  assert.equal(install.installCommand[1], '-c');
  const script = install.installCommand[2];
  assert.match(script, /^cd /);
  assert.match(script, /agent-workforce\/sessions\/test-run\/claude\/plugin/);
  assert.match(script, /npx -y prpm install @prpm\/npm-trusted-publishing --as claude/);
  // Per-skill cleanupPaths is empty; cleanup lives at the plan level.
  assert.deepEqual([...install.cleanupPaths], []);
});

test('materializeSkills rejects installRoot for non-claude harnesses', () => {
  assert.throws(
    () =>
      materializeSkills(
        [
          {
            id: 'prpm/x',
            source: '@prpm/x',
            description: 'x'
          }
        ],
        'codex',
        { installRoot: '/tmp/agent-workforce/sessions/abc/claude/plugin' }
      ),
    /installRoot is only supported for the claude harness/
  );
});

test('useSelection with installRoot emits scaffold + chained prpm in install.commandString', () => {
  const installRoot = '/tmp/agent-workforce/sessions/scaffold-test/claude/plugin';
  const selection = resolvePersonaByTier('npm-provenance', 'best-value');
  // Force harness=claude so the installRoot path is exercised regardless of
  // the persona's default tier harness.
  const context = useSelection(selection, { harness: 'claude', installRoot });
  assert.equal(context.install.plan.sessionInstallRoot, installRoot);
  const cmd = context.install.commandString;
  // Scaffold: the three mkdir/ln/printf steps go first.
  assert.match(cmd, /^mkdir -p /);
  assert.match(cmd, /\.claude-plugin/);
  assert.match(cmd, /ln -sfn \.claude\/skills /);
  assert.match(cmd, /printf '%s' /);
  // Then a single cd into the stage dir, then the prpm call.
  assert.match(cmd, / && cd '?\/tmp\/agent-workforce\/sessions\/scaffold-test\/claude\/plugin'? && /);
  assert.match(cmd, /npx -y prpm install @prpm\/npm-trusted-publishing --as claude/);
});

test('useSelection with installRoot collapses cleanup to a single rm -rf of the stage dir', () => {
  const installRoot = '/tmp/agent-workforce/sessions/cleanup-test/claude/plugin';
  const selection = resolvePersonaByTier('npm-provenance', 'best-value');
  const context = useSelection(selection, { harness: 'claude', installRoot });
  // shellEscape leaves paths made of [A-Za-z0-9_./:@%+=,-] unquoted.
  assert.equal(
    context.install.cleanupCommandString,
    `rm -rf /tmp/agent-workforce/sessions/cleanup-test/claude/plugin`
  );
});

test('materializeSkills with installRoot + no skills still reports the sessionInstallRoot', () => {
  const installRoot = '/tmp/agent-workforce/sessions/empty/claude/plugin';
  const plan = materializeSkills([], 'claude', { installRoot });
  assert.equal(plan.sessionInstallRoot, installRoot);
  assert.equal(plan.installs.length, 0);
});

test('resolves capability-discovery persona carrying both skill.sh and prpm skills', () => {
  const selection = resolvePersona('capability-discovery');
  assert.equal(selection.personaId, 'capability-discoverer');
  assert.equal(selection.tier, 'best-value');
  assert.equal(selection.skills.length, 2);

  const byId = new Map(selection.skills.map((s) => [s.id, s]));
  const skillSh = byId.get('skill.sh/find-skills');
  assert.ok(skillSh, 'missing skill.sh/find-skills skill');
  assert.equal(skillSh!.source, 'https://github.com/vercel-labs/skills#find-skills');
  const prpm = byId.get('prpm/self-improving');
  assert.ok(prpm, 'missing prpm/self-improving skill');
  assert.match(prpm!.source, /prpm\.dev\/packages\/@prpm\/self-improving/);
});

test('materializeSkillsFor capability-discovery plans both installs under one shell chain with cleanup', () => {
  const selection = resolvePersona('capability-discovery');
  const plan = materializeSkillsFor(selection);
  assert.equal(plan.installs.length, 2);

  const byKind = new Map(plan.installs.map((i) => [i.sourceKind, i]));
  const skillShInstall = byKind.get('skill.sh');
  const prpmInstall = byKind.get('prpm');
  assert.ok(skillShInstall, 'missing skill.sh install');
  assert.ok(prpmInstall, 'missing prpm install');
  assert.deepEqual(
    [...skillShInstall!.installCommand],
    ['npx', '-y', 'skills', 'add', 'https://github.com/vercel-labs/skills', '--skill', 'find-skills', '-y']
  );
  assert.equal(prpmInstall!.packageRef, '@prpm/self-improving');

  const context = usePersona('capability-discovery');
  const cmd = context.install.commandString;
  // Both installs should be chained back-to-back with `&&`, with NO inline
  // cleanup — cleanup lives on a separate post-agent step.
  assert.match(
    cmd,
    /skills add https:\/\/github\.com\/vercel-labs\/skills --skill find-skills -y && npx -y prpm install @prpm\/self-improving/
  );
  assert.doesNotMatch(cmd, /rm -rf/);
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

test('usePersona combines selection, grouped install metadata, and sendMessage into a frozen context', () => {
  const context = usePersona('npm-provenance');
  const selection = resolvePersona('npm-provenance');
  const plan = materializeSkillsFor(selection);

  assert.deepEqual(context.selection, selection);
  assert.deepEqual(context.install.plan, plan);
  assert.equal(context.install.command[0], 'sh');
  assert.match(context.install.commandString, /prpm install/);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.selection));
  assert.ok(Object.isFrozen(context.install));
  assert.ok(Object.isFrozen(context.install.plan));
  assert.ok(Object.isFrozen(context.install.command));
});

test('usePersona.sendMessage runs the selected harness and returns stdout, stderr, and run metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'use-persona-success-'));
  try {
    writeNodeExecutable(
      dir,
      'codex',
      `
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync('codex-args.json', JSON.stringify(args), 'utf8');
writeFileSync('codex-env.json', JSON.stringify({ TEST_ENV: process.env.TEST_ENV }), 'utf8');
process.stdout.write('stub-stdout');
process.stderr.write('stub-stderr');
`
    );

    const context = usePersona('architecture-plan', { harness: 'codex' });
    const progress: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const execution = context.sendMessage('Draft the migration plan', {
      workingDirectory: dir,
      env: buildEnv(dir, { TEST_ENV: 'persona-send-message' }),
      onProgress: (chunk) => progress.push(chunk)
    });

    const runId = await execution.runId;
    const result = await execution;
    const args = JSON.parse(readFileSync(join(dir, 'codex-args.json'), 'utf8')) as string[];
    const env = JSON.parse(readFileSync(join(dir, 'codex-env.json'), 'utf8')) as {
      TEST_ENV: string;
    };

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'stub-stdout');
    assert.equal(result.stderr, 'stub-stderr');
    assert.equal(result.exitCode, 0);
    assert.equal(result.workflowRunId, runId);
    assert.deepEqual(args.slice(0, 2), ['exec', '--dangerously-bypass-approvals-and-sandbox']);
    assert.match(args[2], /System Instructions:/);
    assert.match(args[2], /Draft the migration plan/);
    assert.deepEqual(env, { TEST_ENV: 'persona-send-message' });
    assert.deepEqual(progress, [
      { stream: 'stdout', text: 'stub-stdout' },
      { stream: 'stderr', text: 'stub-stderr' }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usePersona.sendMessage installs persona skills before running the agent step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'use-persona-install-'));
  try {
    writeNodeExecutable(
      dir,
      'npx',
      `
const { writeFileSync } = require('node:fs');
writeFileSync('install-ran.txt', process.argv.slice(2).join(' '), 'utf8');
`
    );
    writeNodeExecutable(
      dir,
      'codex',
      `
const { existsSync, writeFileSync } = require('node:fs');
if (!existsSync('install-ran.txt')) {
  process.stderr.write('install step did not run');
  process.exit(9);
}
writeFileSync('agent-saw-install.txt', 'yes', 'utf8');
process.stdout.write('agent-after-install');
`
    );

    const context = usePersona('npm-provenance', { harness: 'codex' });
    const result = await context.sendMessage('Configure publishing', {
      workingDirectory: dir,
      env: buildEnv(dir)
    });

    assert.equal(result.status, 'completed');
    assert.match(readFileSync(join(dir, 'install-ran.txt'), 'utf8'), /prpm install/);
    assert.equal(readFileSync(join(dir, 'agent-saw-install.txt'), 'utf8'), 'yes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usePersona.sendMessage keeps skill files on disk for the agent, then cleans them up after', async () => {
  // Regression guard for the Devin-flagged P1: cleanup used to be chained
  // into the install step with `&& rm -rf`, so by the time the agent step
  // ran the skill manifest was already gone. This test:
  //   1. Uses a fake `npx` that writes a stub SKILL.md into the exact path
  //      listed in the install plan's cleanupPaths (simulating prpm install).
  //   2. Uses a fake `codex` that asserts the SKILL.md IS present and
  //      captures its location, then writes an agent-ran sentinel.
  //   3. Asserts that after sendMessage settles, the cleanupPaths have been
  //      removed — proving the post-agent cleanup step ran.
  const dir = mkdtempSync(join(tmpdir(), 'use-persona-cleanup-'));
  try {
    // The install plan cleanupPaths for npm-provenance under codex is
    // `.agents/skills/npm-trusted-publishing`. The fake npx must materialize
    // a SKILL.md inside that dir so the agent can verify it.
    writeNodeExecutable(
      dir,
      'npx',
      `
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const skillDir = path.join(process.cwd(), '.agents/skills/npm-trusted-publishing');
mkdirSync(skillDir, { recursive: true });
writeFileSync(path.join(skillDir, 'SKILL.md'), '# npm trusted publishing', 'utf8');
`
    );
    writeNodeExecutable(
      dir,
      'codex',
      `
const { existsSync, writeFileSync } = require('node:fs');
const skillPath = '.agents/skills/npm-trusted-publishing/SKILL.md';
if (!existsSync(skillPath)) {
  process.stderr.write('SKILL.md missing during agent step');
  process.exit(9);
}
writeFileSync('agent-saw-skill.txt', 'yes', 'utf8');
process.stdout.write('agent-read-skill');
`
    );

    const context = usePersona('npm-provenance', { harness: 'codex' });
    // Sanity check: plan must say this is the path we expect to verify.
    assert.deepEqual(
      context.install.plan.installs[0]?.cleanupPaths,
      ['.agents/skills/npm-trusted-publishing']
    );

    const result = await context.sendMessage('Configure publishing', {
      workingDirectory: dir,
      env: buildEnv(dir)
    });

    assert.equal(result.status, 'completed');
    // Agent must have seen the skill during its run.
    assert.equal(readFileSync(join(dir, 'agent-saw-skill.txt'), 'utf8'), 'yes');
    // Post-agent cleanup must have removed the skill artifact path.
    assert.equal(
      existsSync(join(dir, '.agents/skills/npm-trusted-publishing')),
      false,
      'cleanup step should have removed the skill artifact dir after the agent ran'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usePersona.sendMessage maps non-zero exits to PersonaExecutionError with captured stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'use-persona-fail-'));
  try {
    writeNodeExecutable(
      dir,
      'codex',
      `
process.stderr.write('boom');
process.exit(17);
`
    );

    const context = usePersona('architecture-plan', { harness: 'codex' });
    await assert.rejects(
      context.sendMessage('Fail this run', {
        workingDirectory: dir,
        env: buildEnv(dir)
      }),
      (error: unknown) => {
        assert.ok(error instanceof PersonaExecutionError);
        assert.equal(error.result.status, 'failed');
        assert.equal(error.result.exitCode, 17);
        assert.equal(error.result.stderr, 'boom');
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usePersona.sendMessage supports cancellation via AbortSignal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'use-persona-cancel-'));
  try {
    writeNodeExecutable(
      dir,
      'codex',
      `
process.stdout.write('started');
setInterval(() => {}, 1_000);
`
    );

    const controller = new AbortController();
    const context = usePersona('architecture-plan', { harness: 'codex' });
    const execution = context.sendMessage('Wait for cancellation', {
      workingDirectory: dir,
      env: buildEnv(dir),
      signal: controller.signal
    });

    await execution.runId;
    controller.abort();

    await assert.rejects(execution, (error: unknown) => {
      const abortError = error as Error & {
        result?: { status?: string; output?: string };
      };
      assert.equal(abortError.name, 'AbortError');
      assert.equal(abortError.result?.status, 'cancelled');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
