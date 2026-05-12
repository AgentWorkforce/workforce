import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bundleStager } from './bundle.js';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

const baseRuntime = {
  harness: 'claude' as const,
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
};

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'bundle-fixture',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'fixture for bundle tests',
    skills: [],
    tiers: { best: baseRuntime, 'best-value': baseRuntime, minimum: baseRuntime },
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
