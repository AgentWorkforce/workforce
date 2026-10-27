import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPersonaMount } from './mount.js';
import type { ResolvedMountPolicy } from './plan.js';

test('applyPersonaMount: undefined policy returns a no-op handle whose cwd matches options.cwd', async () => {
  const handle = await applyPersonaMount(undefined, { cwd: '/some/where' });
  assert.equal(handle.cwd, '/some/where');
  // Idempotent
  await handle.dispose();
  await handle.dispose();
});

test('applyPersonaMount: undefined policy ignores missing mountDir + personaId', async () => {
  // The no-op branch must not require mount-only options. This guards against
  // a regression where mount validation happens before the no-op short-circuit.
  const handle = await applyPersonaMount(undefined, { cwd: '/x' });
  assert.equal(handle.cwd, '/x');
  await handle.dispose();
});

test('applyPersonaMount: declared policy without mountDir throws a clear error', async () => {
  const mount: ResolvedMountPolicy = {
    ignoredPatterns: ['secrets/**'],
    readonlyPatterns: []
  };
  await assert.rejects(
    applyPersonaMount(mount, { cwd: '/x', personaId: 'p' }),
    /options\.mountDir is required when a mount policy is supplied/
  );
});

test('applyPersonaMount: declared policy without personaId throws a clear error', async () => {
  const mount: ResolvedMountPolicy = {
    ignoredPatterns: [],
    readonlyPatterns: ['vendor/**']
  };
  await assert.rejects(
    applyPersonaMount(mount, { cwd: '/x', mountDir: '/scratch/mount' }),
    /options\.personaId is required when a mount policy is supplied/
  );
});

test('applyPersonaMount: multi-root mount creates a subdir per alias and tears them down on dispose', async () => {
  // Real on-disk sources + mountDir; the underlying relayfile primitive
  // does a one-shot mirror at createMount time, so this exercises the
  // full N-mount lifecycle. Reverse-order cleanup is verified by removing
  // the mountDir tree afterwards — handles must not leave orphan watchers.
  const root = await mkdtemp(join(tmpdir(), 'aw-mount-roots-'));
  try {
    const apiSrc = join(root, 'src-api');
    const webSrc = join(root, 'src-web');
    const mountDir = join(root, 'mount');
    await mkdir(apiSrc, { recursive: true });
    await mkdir(webSrc, { recursive: true });
    await writeFile(join(apiSrc, 'README.md'), 'api');
    await writeFile(join(webSrc, 'README.md'), 'web');

    const mount: ResolvedMountPolicy = {
      ignoredPatterns: ['node_modules'],
      readonlyPatterns: [],
      roots: [
        {
          alias: 'api',
          path: apiSrc,
          readonly: true,
          ignoredPatterns: [],
          readonlyPatterns: ['**']
        },
        {
          alias: 'web',
          path: webSrc,
          readonly: false,
          ignoredPatterns: [],
          readonlyPatterns: []
        }
      ]
    };
    const handle = await applyPersonaMount(mount, {
      cwd: root,
      mountDir,
      personaId: 'multi-root-test',
      includeGit: false
    });
    try {
      assert.equal(handle.cwd, mountDir);
      assert.deepEqual([...handle.aliases], ['api', 'web']);
      const apiMount = join(mountDir, 'api');
      const webMount = join(mountDir, 'web');
      assert.ok((await readdir(apiMount)).includes('README.md'), 'api alias should mirror its source');
      assert.ok((await readdir(webMount)).includes('README.md'), 'web alias should mirror its source');
    } finally {
      await handle.dispose();
      // Idempotent.
      await handle.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applyPersonaMount: autoSync flushes harness changes before disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-mount-autosync-'));
  const project = join(root, 'project');
  const mountDir = join(root, 'mount');
  await mkdir(project);
  await writeFile(join(project, 'input.txt'), 'input');

  try {
    const handle = await applyPersonaMount(
      { ignoredPatterns: [], readonlyPatterns: [] },
      {
        cwd: project,
        mountDir,
        personaId: 'autosync-test',
        includeGit: false,
        autoSync: { scanIntervalMs: 0, healthyScanIntervalMs: 0 }
      }
    );
    await writeFile(join(handle.cwd, 'result.txt'), 'persisted');
    await handle.dispose();

    assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'persisted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applyPersonaMount: no-op handle reports empty aliases', async () => {
  const handle = await applyPersonaMount(undefined, { cwd: '/x' });
  assert.deepEqual([...handle.aliases], []);
  await handle.dispose();
});
