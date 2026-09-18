import test from 'node:test';
import assert from 'node:assert/strict';
import { devLauncher, localLauncher, pickMode, type DeployMode } from './index.js';

test('local launcher exports preserve deprecated identity', () => {
  assert.equal(devLauncher, localLauncher);
  assert.equal(typeof localLauncher.launch, 'function');
  // @ts-expect-error dev is accepted only as a legacy option, never as DeployMode.
  const invalid: DeployMode = 'dev';
  void invalid;
});
test('pickMode defaults to local and normalizes legacy dev', () => {
  const old = [process.env.DAYTONA_API_KEY, process.env.WORKFORCE_WORKSPACE_TOKEN];
  try {
    delete process.env.DAYTONA_API_KEY; delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    assert.equal(pickMode({ personaPath: 'unused' }), 'local');
    assert.equal(pickMode({ personaPath: 'unused', mode: 'dev' }), 'local');
  } finally {
    ['DAYTONA_API_KEY', 'WORKFORCE_WORKSPACE_TOKEN'].forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    });
  }
});
