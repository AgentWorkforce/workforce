import test from 'node:test';
import assert from 'node:assert/strict';
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
