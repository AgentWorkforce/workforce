import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonaSpawnPlan, type ResolvedPersona } from './plan.js';
import type { Harness } from './types.js';

function persona(over: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    personaId: 'p',
    tier: 'best-value',
    runtime: {
      harness: 'claude',
      model: 'anthropic/claude-3-5-sonnet',
      systemPrompt: 'be helpful',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
    },
    skills: [],
    rationale: 'test',
    ...over
  };
}

const cleanEnv: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

test('buildPersonaSpawnPlan returns the persona, cli, and args for claude', () => {
  const plan = buildPersonaSpawnPlan(persona(), { processEnv: cleanEnv });
  assert.equal(plan.cli, 'claude');
  assert.ok(plan.args.length > 0);
  assert.equal(plan.persona.personaId, 'p');
  assert.deepEqual(plan.skills.installs, []);
  assert.deepEqual(plan.sidecars, []);
  assert.equal(plan.mount, undefined);
  assert.deepEqual(plan.inputs, []);
  assert.equal(plan.initialPrompt, undefined);
});

test('buildPersonaSpawnPlan emits initialPrompt for codex', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      runtime: {
        harness: 'codex',
        model: 'openai/gpt-5',
        systemPrompt: 'codex prompt',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
      }
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.cli, 'codex');
  assert.equal(plan.initialPrompt, 'codex prompt');
});

test('buildPersonaSpawnPlan emits configFiles for opencode', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      personaId: 'sample',
      runtime: {
        harness: 'opencode',
        model: 'anthropic/claude-3-5-sonnet',
        systemPrompt: 'opencode prompt',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
      }
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.cli, 'opencode');
  assert.ok(
    plan.configFiles.some((f) => f.path.endsWith('opencode.json')),
    'opencode plan must emit an opencode.json'
  );
});

test('buildPersonaSpawnPlan resolves sidecars from claudeMdContent / agentsMdContent', () => {
  const claudePlan = buildPersonaSpawnPlan(
    persona({
      claudeMdContent: '# claude sidecar',
      claudeMdMode: 'overwrite'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(claudePlan.sidecars.length, 1);
  assert.equal(claudePlan.sidecars[0].filename, 'CLAUDE.md');
  assert.equal(claudePlan.sidecars[0].contents, '# claude sidecar');

  const opencodePlan = buildPersonaSpawnPlan(
    persona({
      agentsMdContent: '# agents sidecar',
      agentsMdMode: 'extend',
      runtime: {
        harness: 'opencode',
        model: 'anthropic/claude-3-5-sonnet',
        systemPrompt: 'be helpful',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
      }
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(opencodePlan.sidecars.length, 1);
  assert.equal(opencodePlan.sidecars[0].filename, 'AGENTS.md');
  assert.equal(opencodePlan.sidecars[0].mode, 'extend');
});

test('buildPersonaSpawnPlan threads mount policy through when patterns present', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      mount: { ignoredPatterns: ['secrets/**'], readonlyPatterns: ['vendor/**'] }
    }),
    { processEnv: cleanEnv }
  );
  assert.deepEqual(plan.mount?.ignoredPatterns, ['secrets/**']);
  assert.deepEqual(plan.mount?.readonlyPatterns, ['vendor/**']);
});

test('buildPersonaSpawnPlan drops empty mount policy', () => {
  const plan = buildPersonaSpawnPlan(persona({ mount: {} }), { processEnv: cleanEnv });
  assert.equal(plan.mount, undefined);
});

test('buildPersonaSpawnPlan resolves inputs into env bindings', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      inputs: {
        OUTPUT_PATH: { default: '/tmp/out' },
        TARGET: { env: 'TARGET_OVERRIDE' }
      }
    }),
    { processEnv: { TARGET_OVERRIDE: 'frobnicate' } as NodeJS.ProcessEnv }
  );
  const byName = Object.fromEntries(plan.inputs.map((b) => [b.name, b]));
  assert.equal(byName.OUTPUT_PATH.envName, 'OUTPUT_PATH');
  assert.equal(byName.OUTPUT_PATH.value, '/tmp/out');
  assert.equal(byName.TARGET.envName, 'TARGET_OVERRIDE');
  assert.equal(byName.TARGET.value, 'frobnicate');
  assert.equal(plan.env.OUTPUT_PATH, '/tmp/out');
  assert.equal(plan.env.TARGET_OVERRIDE, 'frobnicate');
});

test('buildPersonaSpawnPlan persona env wins over inputs and overrides', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      env: { FOO: 'persona-wins' },
      inputs: { FOO: { default: 'from-input' } }
    }),
    {
      processEnv: cleanEnv,
      envOverrides: { FOO: 'override-value' }
    }
  );
  assert.equal(plan.env.FOO, 'persona-wins');
});

test('buildPersonaSpawnPlan is JSON-serializable', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      claudeMdContent: '# sidecar',
      mount: { ignoredPatterns: ['x'] },
      env: { FOO: 'bar' }
    }),
    { processEnv: cleanEnv }
  );
  const round = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(round.cli, plan.cli);
  assert.deepEqual(round.args, plan.args);
  assert.deepEqual(round.sidecars, plan.sidecars);
  assert.deepEqual(round.mount, plan.mount);
  assert.deepEqual(round.env, plan.env);
});

test('buildPersonaSpawnPlan threads installRoot into the skill plan', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      skills: [
        {
          id: 'prpm/x',
          source: '@scope/x',
          description: 'd'
        }
      ]
    }),
    { processEnv: cleanEnv, installRoot: '/tmp/session/plugin' }
  );
  assert.equal(plan.skills.sessionInstallRoot, '/tmp/session/plugin');
  // Plugin dirs flow through into the claude argv.
  assert.ok(
    plan.args.some((arg) => arg === '/tmp/session/plugin'),
    'plugin-dir from installRoot should appear in claude argv'
  );
});

test('buildPersonaSpawnPlan emits sourcePath when only claudeMd path is set', () => {
  const plan = buildPersonaSpawnPlan(
    persona({ claudeMd: '/abs/path/to/CLAUDE.md', claudeMdMode: 'extend' }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.sidecars.length, 1);
  assert.equal(plan.sidecars[0].filename, 'CLAUDE.md');
  assert.equal(plan.sidecars[0].sourcePath, '/abs/path/to/CLAUDE.md');
  assert.equal(plan.sidecars[0].contents, undefined);
  assert.equal(plan.sidecars[0].mode, 'extend');
});

test('buildPersonaSpawnPlan emits sourcePath for opencode/codex agentsMd path', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      runtime: {
        harness: 'opencode',
        model: 'm',
        systemPrompt: 's',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
      },
      agentsMd: '/abs/path/to/AGENTS.md'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.sidecars.length, 1);
  assert.equal(plan.sidecars[0].sourcePath, '/abs/path/to/AGENTS.md');
});

test('buildPersonaSpawnPlan does not capture ambient env by default', () => {
  // No processEnv or includeProcessEnv — plan.env should only carry persona/input bindings.
  const plan = buildPersonaSpawnPlan(persona({ env: { ONLY: 'persona' } }));
  assert.deepEqual(plan.env, { ONLY: 'persona' });
});

test('buildPersonaSpawnPlan opt-in includeProcessEnv captures process.env', () => {
  const sentinel = `__PK_TEST_${Date.now()}_${Math.random()}__`;
  process.env[sentinel] = 'on';
  try {
    const plan = buildPersonaSpawnPlan(persona(), { includeProcessEnv: true });
    assert.equal(plan.env[sentinel], 'on');
  } finally {
    delete process.env[sentinel];
  }
});

test('buildPersonaSpawnPlan empty-skills case keeps installs empty', () => {
  for (const harness of ['claude', 'codex', 'opencode'] as Harness[]) {
    const plan = buildPersonaSpawnPlan(
      persona({
        runtime: {
          harness,
          model: 'm',
          systemPrompt: 's',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        }
      }),
      { processEnv: cleanEnv }
    );
    assert.equal(plan.skills.installs.length, 0, `harness ${harness}`);
  }
});
