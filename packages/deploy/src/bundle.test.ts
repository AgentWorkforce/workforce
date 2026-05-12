import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageBundle, type BundleInput } from './bundle.js';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-bundle-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function basePersona(over: Record<string, unknown> = {}): PersonaSpec {
  const runtime = {
    harness: 'claude' as const,
    model: 'claude-3-5-sonnet',
    systemPrompt: 'test',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
  };
  return {
    id: 'deploy-fixture',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'Deploy fixture persona.',
    skills: [],
    tiers: { best: runtime, 'best-value': runtime, minimum: runtime },
    ...over
  };
}

test('stageBundle writes persona, runner, package metadata, and esbuild bundle', async () => {
  await withTmpDir(async (dir) => {
    const personaPath = resolve('src/__fixtures__/simple-agent/persona.json');
    const outDir = join(dir, 'build');
    const result = await stageBundle({
      personaPath,
      persona: basePersona({ onEvent: './agent.ts' }),
      outDir
    } as BundleInput);

    assert.equal(result.personaCopyPath, join(outDir, 'persona.json'));
    assert.equal(result.runnerPath, join(outDir, 'runner.mjs'));
    assert.equal(result.bundlePath, join(outDir, 'agent.bundle.mjs'));
    assert.equal(result.packageJsonPath, join(outDir, 'package.json'));
    assert.ok(result.sizeBytes > 0);

    assert.match(await readFile(result.bundlePath, 'utf8'), /fixture handler/);
    assert.equal(
      await readFile(result.runnerPath, 'utf8'),
      `import { startRunner } from '@agentworkforce/runtime/runner';
import persona from './persona.json' assert { type: 'json' };
import * as agentModule from './agent.bundle.mjs';
const handler = agentModule.default ?? agentModule.handler;
startRunner({ persona, handler });
`
    );
    assert.deepEqual(JSON.parse(await readFile(result.personaCopyPath, 'utf8')), {
      ...basePersona(),
      onEvent: './agent.ts'
    });
    assert.equal(
      JSON.parse(await readFile(result.packageJsonPath, 'utf8')).dependencies[
        '@agentworkforce/runtime'
      ],
      '2.1.4'
    );
  });
});

test('stageBundle cleans and rewrites the output directory on repeated runs', async () => {
  await withTmpDir(async (dir) => {
    const personaPath = resolve('src/__fixtures__/simple-agent/persona.json');
    const outDir = join(dir, 'build');
    await stageBundle({ personaPath, persona: basePersona({ onEvent: './agent.ts' }), outDir });
    await stageBundle({ personaPath, persona: basePersona({ onEvent: './agent.ts' }), outDir });

    assert.equal((await stat(join(outDir, 'runner.mjs'))).isFile(), true);
  });
});

test('stageBundle rejects a missing onEvent file', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      stageBundle({
        personaPath: resolve('src/__fixtures__/simple-agent/persona.json'),
        persona: basePersona({ onEvent: './missing.ts' }),
        outDir: join(dir, 'build')
      }),
      /onEvent file does not exist/
    );
  });
});
