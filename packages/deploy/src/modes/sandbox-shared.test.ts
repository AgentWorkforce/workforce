import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotentStop, destroyOnFailure, resolveSandboxAuthMode } from './sandbox-shared.js';

test('sandbox auth retains exact errors and mode selection', () => {
  const keys = ['DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN', 'WORKFORCE_WORKSPACE_TOKEN'];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(() => resolveSandboxAuthMode({}, { forceByo: true }), { message: 'sandbox launcher: --byo-sandbox requested but no Daytona credentials are in env. Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID).' });
    assert.throws(() => resolveSandboxAuthMode({}), { message: 'sandbox launcher: no Daytona credentials and no workforce workspace token. Either export DAYTONA_API_KEY, or run `workforce login` (sets WORKFORCE_WORKSPACE_TOKEN) so we can mint a workforce-managed sandbox.' });
    assert.equal(resolveSandboxAuthMode({ workspaceToken: 'token' }), 'managed');
    process.env.DAYTONA_API_KEY = 'key';
    assert.equal(resolveSandboxAuthMode({ workspaceToken: 'token' }), 'byo');
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});
test('sandbox stop returns the same promise and warns once on cleanup failure', async () => {
  let calls = 0; const warnings: string[] = [];
  const stop = createIdempotentStop(async () => { calls++; throw new Error('failed'); }, { warn: value => warnings.push(value) });
  const first = stop(); assert.equal(stop(), first);
  await first;
  assert.equal(calls, 1); assert.deepEqual(warnings, ['sandbox: cleanup failed: failed']);
});
test('sandbox destroyOnFailure preserves the original failure', async () => {
  const original = new Error('original');
  await assert.rejects(destroyOnFailure(async () => { throw new Error('cleanup'); }, original), err => err === original);
});
