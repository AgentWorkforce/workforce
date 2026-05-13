import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bundleStager } from './bundle.js';
import { runtimeContextEnv } from './runtime-context.js';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'bundle-fixture',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'fixture for bundle tests',
    skills: [],
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
    onEvent: './agent.ts',
    ...overrides
  };
}

test('bundleStager produces an executable, importable bundle from a real onEvent file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import { handler } from '@agentworkforce/runtime';",
        '',
        'export default handler(async (ctx, event) => {',
        "  ctx.log('info', 'fixture.handler.fired', { eventId: event.id });",
        '});',
        ''
      ].join('\n'),
      'utf8'
    );

    const outDir = path.join(dir, 'build');
    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir
    });

    assert.equal(result.personaCopyPath, path.join(outDir, 'persona.json'));
    assert.equal(result.runnerPath, path.join(outDir, 'runner.mjs'));
    assert.equal(result.bundlePath, path.join(outDir, 'agent.bundle.mjs'));
    assert.equal(result.packageJsonPath, path.join(outDir, 'package.json'));
    assert.ok(result.sizeBytes > 0);

    // persona.json round-trips verbatim
    const personaCopy = JSON.parse(await readFile(result.personaCopyPath, 'utf8'));
    assert.equal(personaCopy.id, personaSpec.id);
    assert.equal(personaCopy.onEvent, './agent.ts');

    // runner imports the expected entry points
    const runnerSource = await readFile(result.runnerPath, 'utf8');
    assert.match(runnerSource, /from '@agentworkforce\/runtime\/runner'/);
    assert.match(runnerSource, /from '@agentworkforce\/runtime'/);
    assert.match(runnerSource, /import \* as userModule from '\.\/agent\.bundle\.mjs'/);
    assert.match(runnerSource, /WORKFORCE_AGENT_CONTEXT/);
    assert.match(runnerSource, /WORKFORCE_DEPLOYMENT_CONTEXT/);
    assert.match(runnerSource, /await startRunner\({ persona, agent, deployment, handler }\)/);

    // bundle output is ES module shape and references the runtime as external
    const bundleSource = await readFile(result.bundlePath, 'utf8');
    assert.match(bundleSource, /^import /m);
    assert.match(bundleSource, /from\s+['"]@agentworkforce\/runtime['"]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager throws when onEvent file is missing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona({ onEvent: './missing.ts' });
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    await assert.rejects(
      () => bundleStager.stage({ personaPath, persona: personaSpec, outDir: path.join(dir, 'build') }),
      /file not found/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager throws when persona has no onEvent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    delete (personaSpec as { onEvent?: string }).onEvent;
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    await assert.rejects(
      () => bundleStager.stage({ personaPath, persona: personaSpec, outDir: path.join(dir, 'build') }),
      /missing onEvent/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtimeContextEnv injects explicit runner row context', () => {
  const env = runtimeContextEnv(persona(), {
    WORKFORCE_AGENT_ID: 'agent_123',
    WORKFORCE_AGENT_DEPLOYED_NAME: 'docs-demo',
    WORKFORCE_DEPLOYMENT_ID: 'deployment_456',
    WORKFORCE_DEPLOYMENT_TRIGGER_KIND: 'inbox'
  });

  assert.deepEqual(JSON.parse(env.WORKFORCE_AGENT_CONTEXT), {
    id: 'agent_123',
    deployedName: 'docs-demo',
    spawnedByAgentId: null
  });
  assert.deepEqual(JSON.parse(env.WORKFORCE_DEPLOYMENT_CONTEXT), {
    id: 'deployment_456',
    triggerKind: 'inbox',
    parentDeploymentId: null
  });
});

test('runtimeContextEnv preserves precomputed row context JSON', () => {
  const env = runtimeContextEnv(persona(), {
    WORKFORCE_AGENT_CONTEXT: '{"id":"agent_real"}',
    WORKFORCE_DEPLOYMENT_CONTEXT: '{"id":"deployment_real"}'
  });

  assert.equal(env.WORKFORCE_AGENT_CONTEXT, '{"id":"agent_real"}');
  assert.equal(env.WORKFORCE_DEPLOYMENT_CONTEXT, '{"id":"deployment_real"}');
});

test('runtimeContextEnv infers radio for integration-triggered agents', () => {
  const env = runtimeContextEnv(
    persona({
      integrations: {
        github: {
          triggers: [{ on: 'pull_request.opened' }]
        }
      }
    }),
    undefined
  );

  assert.equal(JSON.parse(env.WORKFORCE_DEPLOYMENT_CONTEXT).triggerKind, 'radio');
});
