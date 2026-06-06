import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonaSpawnPlan, type ResolvedPersona } from './plan.js';
import type { Harness } from './types.js';

function persona(over: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    personaId: 'p',
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    skills: [],
    rationale: 'test',
    ...over
  };
}

const cleanEnv: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

function assertAiHistServer(server: unknown, env: Record<string, string>): void {
  assert.deepEqual(server, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '-p', 'ai-hist', 'ai-hist-mcp'],
    env
  });
}

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

test('buildPersonaSpawnPlan injects ai-hist when memory.aiMemory is opted in', () => {
  const plan = buildPersonaSpawnPlan(persona({ memory: { aiMemory: true } }), {
    processEnv: cleanEnv
  });
  const mcpIdx = plan.args.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, 'expected --mcp-config');
  const payload = JSON.parse(plan.args[mcpIdx + 1]);
  assertAiHistServer(payload.mcpServers['ai-hist'], {});
});

test('buildPersonaSpawnPlan threads ai-hist env overrides when aiMemory is on', () => {
  const plan = buildPersonaSpawnPlan(persona({ memory: { aiMemory: true } }), {
    processEnv: {
      TRAJECTORY_ROOT: '/repo/.trajectories',
      AI_HIST_DB: '/tmp/ai-history.db'
    } as NodeJS.ProcessEnv
  });
  const mcpIdx = plan.args.indexOf('--mcp-config');
  const payload = JSON.parse(plan.args[mcpIdx + 1]);
  assert.deepEqual(payload.mcpServers['ai-hist'].env, {
    TRAJECTORY_ROOT: '/repo/.trajectories',
    AI_HIST_DB: '/tmp/ai-history.db'
  });
});

test('buildPersonaSpawnPlan: memory.aiMemory.dbPath overrides the history DB', () => {
  const plan = buildPersonaSpawnPlan(persona({ memory: { aiMemory: { dbPath: '/custom/hist.db' } } }), {
    processEnv: cleanEnv
  });
  const mcpIdx = plan.args.indexOf('--mcp-config');
  const payload = JSON.parse(plan.args[mcpIdx + 1]);
  assert.deepEqual(payload.mcpServers['ai-hist'].env, { AI_HIST_DB: '/custom/hist.db' });
});

test('buildPersonaSpawnPlan omits ai-hist when memory.aiMemory is not opted in', () => {
  // Default (no memory) — off.
  const off = buildPersonaSpawnPlan(persona(), { processEnv: cleanEnv });
  const offIdx = off.args.indexOf('--mcp-config');
  assert.equal(JSON.parse(off.args[offIdx + 1]).mcpServers['ai-hist'], undefined);

  // `memory: true` enables long-form memory only, NOT the aiMemory facet.
  const longFormOnly = buildPersonaSpawnPlan(persona({ memory: true }), { processEnv: cleanEnv });
  const lfIdx = longFormOnly.args.indexOf('--mcp-config');
  assert.equal(JSON.parse(longFormOnly.args[lfIdx + 1]).mcpServers['ai-hist'], undefined);

  // Explicit opt-out.
  const explicitOff = buildPersonaSpawnPlan(persona({ memory: { aiMemory: false } }), {
    processEnv: cleanEnv
  });
  const eoIdx = explicitOff.args.indexOf('--mcp-config');
  assert.equal(JSON.parse(explicitOff.args[eoIdx + 1]).mcpServers['ai-hist'], undefined);
});

test('buildPersonaSpawnPlan emits initialPrompt for codex', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      harness: 'codex',
      model: 'openai/gpt-5',
      systemPrompt: 'codex prompt'
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
      harness: 'opencode',
      systemPrompt: 'opencode prompt'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.cli, 'opencode');
  assert.ok(
    plan.configFiles.some((f) => f.path.endsWith('opencode.json')),
    'opencode plan must emit an opencode.json'
  );
});

test('buildPersonaSpawnPlan emits AGENTS.md configFile for grok systemPrompt', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      personaId: 'sample',
      harness: 'grok',
      model: 'grok-build-0.1',
      systemPrompt: 'grok prompt'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.cli, 'grok');
  assert.deepEqual(plan.configFiles, [
    { path: 'AGENTS.md', contents: 'grok prompt\n' }
  ]);
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
      harness: 'opencode'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(opencodePlan.sidecars.length, 1);
  assert.equal(opencodePlan.sidecars[0].filename, 'AGENTS.md');
  assert.equal(opencodePlan.sidecars[0].mode, 'extend');

  const grokPlan = buildPersonaSpawnPlan(
    persona({
      agentsMdContent: '# grok agents sidecar',
      harness: 'grok',
      model: 'grok-build-0.1'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(grokPlan.sidecars.length, 1);
  assert.equal(grokPlan.sidecars[0].filename, 'AGENTS.md');
  assert.equal(grokPlan.sidecars[0].contents, '# grok agents sidecar');
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

test('buildPersonaSpawnPlan suppresses mount policy when explicitly disabled', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      mount: { enabled: false, ignoredPatterns: ['secrets/**'] }
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.mount, undefined);
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

test('buildPersonaSpawnPlan emits sourcePath for AGENTS.md harness agentsMd path', () => {
  const plan = buildPersonaSpawnPlan(
    persona({
      harness: 'opencode',
      model: 'm',
      systemPrompt: 's',
      agentsMd: '/abs/path/to/AGENTS.md'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(plan.sidecars.length, 1);
  assert.equal(plan.sidecars[0].sourcePath, '/abs/path/to/AGENTS.md');

  const grokPlan = buildPersonaSpawnPlan(
    persona({
      harness: 'grok',
      model: 'grok-build-0.1',
      systemPrompt: 's',
      agentsMd: '/abs/path/to/AGENTS.md'
    }),
    { processEnv: cleanEnv }
  );
  assert.equal(grokPlan.sidecars.length, 1);
  assert.equal(grokPlan.sidecars[0].sourcePath, '/abs/path/to/AGENTS.md');
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
  for (const harness of ['claude', 'codex', 'opencode', 'grok'] as Harness[]) {
    const plan = buildPersonaSpawnPlan(
      persona({
        harness,
        model: 'm',
        systemPrompt: 's'
      }),
      { processEnv: cleanEnv }
    );
    assert.equal(plan.skills.installs.length, 0, `harness ${harness}`);
  }
});
