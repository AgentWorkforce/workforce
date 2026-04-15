import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  usePersona
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
