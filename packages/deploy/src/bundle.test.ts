import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { bundleStager } from './bundle.js';
import { runtimeContextEnv } from './runtime-context.js';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

const require = createRequire(import.meta.url);

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
        "import { defineAgent } from '@agentworkforce/runtime';",
        '',
        'export default defineAgent({',
        "  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],",
        '  handler: async (ctx, event) => {',
        "    ctx.log('info', 'fixture.handler.fired', { eventId: event.id });",
        '  }',
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
    assert.match(runnerSource, /exported\.launchedBy/);
    assert.match(runnerSource, /packageJson\.bundleManifest/);
    assert.match(runnerSource, /await startRunner\({ persona, agent, deployment, handler, bundleManifest/);

    // bundle output is ES module shape and references the runtime as external
    const bundleSource = await readFile(result.bundlePath, 'utf8');
    assert.match(bundleSource, /^import /m);
    assert.match(bundleSource, /from\s+['"]@agentworkforce\/runtime['"]/);

    // package.json pins the exact installed runtime version — never a
    // wildcard a sandbox's npm install could silently satisfy with a
    // stale pre-baked/cached copy.
    const generatedPackageJsonSource = await readFile(result.packageJsonPath, 'utf8');
    const generatedPackageJson = JSON.parse(generatedPackageJsonSource);
    const runtimeDep = generatedPackageJson.dependencies['@agentworkforce/runtime'];
    const installedRuntimePackageJsonPath = require.resolve('@agentworkforce/runtime/package.json');
    const installedRuntimeVersion = JSON.parse(
      await readFile(installedRuntimePackageJsonPath, 'utf8')
    ).version;
    assert.equal(runtimeDep, installedRuntimeVersion);
    assert.notEqual(runtimeDep, '*');
    assert.deepEqual(generatedPackageJson.bundleManifest, { schemaVersion: 1, packages: [] });
    assert.equal(generatedPackageJsonSource.includes(dir), false, 'artifact metadata must not leak build paths');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager records only actual bundled package versions in deterministic order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-manifest-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');

    await writePackage(dir, '@relayfile/relay-helpers', '0.4.9', 'export const relayVersion = "0.4.9";\n');
    await writePackage(dir, 'alpha-bundled', '2.3.4', 'export const alpha = "alpha";\n');
    await writePackage(dir, 'unused-declaration', '9.9.9', 'export const unused = true;\n');
    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import { relayVersion } from '@relayfile/relay-helpers';",
        "import { alpha } from 'alpha-bundled';",
        'export default async function handler() {',
        '  return `${relayVersion}:${alpha}`;',
        '}',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build')
    });
    const generatedPackageJsonSource = await readFile(result.packageJsonPath, 'utf8');
    const generatedPackageJson = JSON.parse(generatedPackageJsonSource);

    assert.deepEqual(generatedPackageJson.bundleManifest, {
      schemaVersion: 1,
      packages: [
        { name: '@relayfile/relay-helpers', version: '0.4.9' },
        { name: 'alpha-bundled', version: '2.3.4' }
      ]
    });
    assert.equal(generatedPackageJsonSource.includes(dir), false, 'manifest must not leak build paths');
    assert.equal(generatedPackageJson.dependencies['@agentworkforce/runtime'], resolveInstalledRuntimeVersion());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager resolves workspace and pnpm package symlinks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-workspace-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');

    const workspacePackage = path.join(dir, 'packages', 'adapter-core');
    await mkdir(workspacePackage, { recursive: true });
    await writeFile(
      path.join(workspacePackage, 'package.json'),
      JSON.stringify({ name: '@relayfile/adapter-core', version: '0.5.7', type: 'module', main: 'index.js' }, null, 2),
      'utf8'
    );
    await writeFile(path.join(workspacePackage, 'index.js'), 'export const adapterVersion = "0.5.7";\n', 'utf8');
    const symlinkParent = path.join(dir, 'node_modules', '@relayfile');
    await mkdir(symlinkParent, { recursive: true });
    await symlink(workspacePackage, path.join(symlinkParent, 'adapter-core'), 'dir');

    const pnpmPackage = path.join(
      dir,
      'node_modules',
      '.pnpm',
      '@relayfile+relay-helpers@0.4.9',
      'node_modules',
      '@relayfile',
      'relay-helpers'
    );
    await mkdir(pnpmPackage, { recursive: true });
    await writeFile(
      path.join(pnpmPackage, 'package.json'),
      JSON.stringify({ name: '@relayfile/relay-helpers', version: '0.4.9', type: 'module', main: 'index.js' }, null, 2),
      'utf8'
    );
    await writeFile(path.join(pnpmPackage, 'index.js'), 'export const relayVersion = "0.4.9";\n', 'utf8');
    await symlink(pnpmPackage, path.join(symlinkParent, 'relay-helpers'), 'dir');

    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import { adapterVersion } from '@relayfile/adapter-core';",
        "import { relayVersion } from '@relayfile/relay-helpers';",
        'export default async function handler() {',
        '  return `${adapterVersion}:${relayVersion}`;',
        '}',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build')
    });
    const generatedPackageJson = JSON.parse(await readFile(result.packageJsonPath, 'utf8'));

    assert.deepEqual(generatedPackageJson.bundleManifest, {
      schemaVersion: 1,
      packages: [
        { name: '@relayfile/adapter-core', version: '0.5.7' },
        { name: '@relayfile/relay-helpers', version: '0.4.9' }
      ]
    });
    const bundledSource = await readFile(result.bundlePath, 'utf8');
    assert.match(bundledSource, /0\.5\.7/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager fails closed for a workspace symlink whose target lacks package metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-missing-workspace-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'author-project', version: '1.0.0', type: 'module' }, null, 2),
      'utf8'
    );

    const workspacePackage = path.join(dir, 'packages', 'missing-workspace');
    await mkdir(workspacePackage, { recursive: true });
    await writeFile(
      path.join(workspacePackage, 'index.js'),
      'export const workspaceMarker = "missing-workspace-marker";\n',
      'utf8'
    );
    const nodeModules = path.join(dir, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    await symlink(workspacePackage, path.join(nodeModules, 'missing-workspace'), 'dir');
    await writeFile(
      path.join(dir, 'agent.ts'),
      "import { workspaceMarker } from 'missing-workspace'; export default () => workspaceMarker;\n",
      'utf8'
    );

    await assert.rejects(
      () => bundleStager.stage({
        personaPath,
        persona: personaSpec,
        outDir: path.join(dir, 'build-missing')
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /bundled package "missing-workspace" has no valid package\.json metadata/
        );
        assert.equal(error.message.includes(dir), false, 'failure must not leak the project path');
        assert.equal(error.message.includes(workspacePackage), false, 'failure must not leak the target path');
        return true;
      }
    );

    await writeFile(path.join(workspacePackage, 'package.json'), '{ not valid json', 'utf8');
    await assert.rejects(
      () => bundleStager.stage({
        personaPath,
        persona: personaSpec,
        outDir: path.join(dir, 'build-invalid')
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'bundle: bundled package "missing-workspace" has no valid package.json metadata'
        );
        assert.equal(error.message.includes(dir), false, 'failure must not leak the project path');
        assert.equal(error.message.includes(workspacePackage), false, 'failure must not leak the target path');
        return true;
      }
    );

    await writeFile(
      path.join(workspacePackage, 'package.json'),
      JSON.stringify(
        { name: 'missing-workspace', version: '2.4.6', type: 'module', main: 'index.js' },
        null,
        2
      ),
      'utf8'
    );
    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build-valid')
    });
    const generatedPackageJson = JSON.parse(await readFile(result.packageJsonPath, 'utf8'));
    assert.deepEqual(generatedPackageJson.bundleManifest.packages, [
      { name: 'missing-workspace', version: '2.4.6' }
    ]);
    assert.match(await readFile(result.bundlePath, 'utf8'), /missing-workspace-marker/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager never attributes a metadata-less symlink target to an unrelated ancestor package', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-unrelated-ancestor-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');

    const unrelatedAncestor = path.join(dir, 'vendor', 'unrelated-ancestor');
    const dependencyTarget = path.join(unrelatedAncestor, 'packages', 'linked-dependency');
    await mkdir(dependencyTarget, { recursive: true });
    await writeFile(
      path.join(unrelatedAncestor, 'package.json'),
      JSON.stringify({ name: 'unrelated-ancestor', version: '9.9.9', type: 'module' }, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(dependencyTarget, 'index.js'),
      'export const linkedMarker = "linked-dependency-marker";\n',
      'utf8'
    );
    const nodeModules = path.join(dir, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    await symlink(dependencyTarget, path.join(nodeModules, 'linked-dependency'), 'dir');
    await writeFile(
      path.join(dir, 'agent.ts'),
      "import { linkedMarker } from 'linked-dependency'; export default () => linkedMarker;\n",
      'utf8'
    );

    await assert.rejects(
      () => bundleStager.stage({
        personaPath,
        persona: personaSpec,
        outDir: path.join(dir, 'build')
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /bundled package "linked-dependency" has no valid package\.json metadata/
        );
        assert.equal(error.message.includes('unrelated-ancestor'), false);
        assert.equal(error.message.includes(dir), false);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager fails closed without leaking paths when bundled package version metadata is absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-versionless-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    const versionlessPackage = path.join(dir, 'node_modules', 'versionless-package');
    await mkdir(versionlessPackage, { recursive: true });
    await writeFile(
      path.join(versionlessPackage, 'package.json'),
      JSON.stringify({ name: 'versionless-package', type: 'module', main: 'index.js' }, null, 2),
      'utf8'
    );
    await writeFile(path.join(versionlessPackage, 'index.js'), 'export const versionless = true;\n', 'utf8');
    await writeFile(
      path.join(dir, 'agent.ts'),
      "import { versionless } from 'versionless-package'; export default () => versionless;\n",
      'utf8'
    );

    await assert.rejects(
      () => bundleStager.stage({
        personaPath,
        persona: personaSpec,
        outDir: path.join(dir, 'build')
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /bundled package "versionless-package" has no valid "version" metadata/);
        assert.equal(error.message.includes(dir), false);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager does not require metadata for a dependency removed from the real output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-tree-shaken-metadata-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    const packageDir = path.join(dir, 'node_modules', 'tree-shaken-versionless');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'tree-shaken-versionless',
        type: 'module',
        main: 'index.js',
        sideEffects: false
      }),
      'utf8'
    );
    await writeFile(path.join(packageDir, 'index.js'), 'export const unused = "unused-marker";\n', 'utf8');
    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import { unused } from 'tree-shaken-versionless';",
        'void unused;',
        'export default () => "handler-result";',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build')
    });
    const generatedPackageJson = JSON.parse(await readFile(result.packageJsonPath, 'utf8'));
    assert.deepEqual(generatedPackageJson.bundleManifest.packages, []);
    assert.doesNotMatch(await readFile(result.bundlePath, 'utf8'), /unused-marker/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager preserves distinct versions of the same package from the actual bundle graph', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-duplicates-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');
    await writePackage(dir, '@relayfile/adapter-core', '0.5.1', 'export const rootAdapter = "0.5.1";\n');
    await writePackage(
      dir,
      'duplicate-host',
      '1.0.0',
      "import { nestedAdapter } from '@relayfile/adapter-core'; export const nested = nestedAdapter;\n"
    );
    const hostRoot = path.join(dir, 'node_modules', 'duplicate-host');
    await writePackage(
      hostRoot,
      '@relayfile/adapter-core',
      '0.5.6',
      'export const nestedAdapter = "0.5.6";\n'
    );
    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import { rootAdapter } from '@relayfile/adapter-core';",
        "import { nested } from 'duplicate-host';",
        'export default async function handler() { return `${rootAdapter}:${nested}`; }',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build')
    });
    const generatedPackageJson = JSON.parse(await readFile(result.packageJsonPath, 'utf8'));

    assert.deepEqual(generatedPackageJson.bundleManifest.packages, [
      { name: '@relayfile/adapter-core', version: '0.5.1' },
      { name: '@relayfile/adapter-core', version: '0.5.6' },
      { name: 'duplicate-host', version: '1.0.0' }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundleStager leaves bare Node builtins external for transitive CommonJS deps', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-bundle-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const personaSpec = persona();
    await writeFile(personaPath, JSON.stringify(personaSpec, null, 2), 'utf8');

    const packageDir = path.join(dir, 'node_modules', 'cjs-process-user');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'cjs-process-user', version: '1.0.0', main: 'index.cjs' }, null, 2),
      'utf8'
    );
    await writeFile(
      path.join(packageDir, 'index.cjs'),
      [
        "const process = require('process');",
        'module.exports = process.release.name;',
        ''
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'agent.ts'),
      [
        "import runtimeName from 'cjs-process-user';",
        '',
        'export default async function handler() {',
        '  return runtimeName;',
        '}',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await bundleStager.stage({
      personaPath,
      persona: personaSpec,
      outDir: path.join(dir, 'build')
    });

    const mod = await import(pathToFileURL(result.bundlePath).href);
    assert.equal(typeof mod.default, 'function');
    assert.equal(await mod.default(), 'node');
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
    persona({ integrations: { github: {} } }),
    undefined,
    { triggers: { github: [{ on: 'pull_request.opened' }] } }
  );

  assert.equal(JSON.parse(env.WORKFORCE_DEPLOYMENT_CONTEXT).triggerKind, 'radio');
});

test('runtimeContextEnv defaults to clock when the agent has no integration triggers', () => {
  const env = runtimeContextEnv(persona(), undefined, {
    schedules: [{ name: 'weekly', cron: '0 9 * * 6' }]
  });
  assert.equal(JSON.parse(env.WORKFORCE_DEPLOYMENT_CONTEXT).triggerKind, 'clock');
});

async function writePackage(
  root: string,
  name: string,
  version: string,
  source: string
): Promise<void> {
  const packageDir = path.join(root, 'node_modules', ...name.split('/'));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name, version, type: 'module', main: 'index.js' }, null, 2),
    'utf8'
  );
  await writeFile(path.join(packageDir, 'index.js'), source, 'utf8');
}

function resolveInstalledRuntimeVersion(): string {
  const installedRuntimePackageJsonPath = require.resolve('@agentworkforce/runtime/package.json');
  return require(installedRuntimePackageJsonPath).version as string;
}
