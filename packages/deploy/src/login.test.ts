import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearActiveWorkspace,
  clearStoredWorkspaceToken,
  loadActiveWorkspaceToken,
  loadWorkspaceToken,
  readActiveWorkspace,
  resolveWorkspaceToken,
  storeWorkspaceToken,
  writeActiveWorkspace,
  writeStoredWorkspaceToken
} from './login.js';
import { createBufferedIO } from './io.js';

async function withWorkspaceEnv<T>(
  env: {
    workspaceId?: string;
    workspaceToken?: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  const previous = {
    WORKFORCE_WORKSPACE_ID: process.env.WORKFORCE_WORKSPACE_ID,
    WORKFORCE_WORKSPACE_TOKEN: process.env.WORKFORCE_WORKSPACE_TOKEN,
    CLOUD_API_ACCESS_TOKEN: process.env.CLOUD_API_ACCESS_TOKEN,
    CLOUD_API_REFRESH_TOKEN: process.env.CLOUD_API_REFRESH_TOKEN,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT,
    CLOUD_API_URL: process.env.CLOUD_API_URL
  };
  if (env.workspaceId === undefined) delete process.env.WORKFORCE_WORKSPACE_ID;
  else process.env.WORKFORCE_WORKSPACE_ID = env.workspaceId;
  if (env.workspaceToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
  else process.env.WORKFORCE_WORKSPACE_TOKEN = env.workspaceToken;
  delete process.env.CLOUD_API_ACCESS_TOKEN;
  delete process.env.CLOUD_API_REFRESH_TOKEN;
  delete process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT;
  delete process.env.CLOUD_API_URL;

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof previous];
      } else {
        process.env[key as keyof typeof previous] = value;
      }
    }
  }
}

test('resolveWorkspaceToken preserves complete WORKFORCE env credentials for CI', async () => {
  await withWorkspaceEnv({
    workspaceId: 'rw_1234abcd',
    workspaceToken: 'ci-token'
  }, async () => {
    assert.deepEqual(
      await resolveWorkspaceToken({
        cloudUrl: 'https://cloud.example.test',
        io: createBufferedIO(),
        noPrompt: true
      }),
      { token: 'ci-token', workspace: 'rw_1234abcd' }
    );
  });
});

test('resolveWorkspaceToken lets --workspace pair with WORKFORCE_WORKSPACE_TOKEN', async () => {
  await withWorkspaceEnv({ workspaceToken: 'ci-token' }, async () => {
    assert.deepEqual(
      await resolveWorkspaceToken({
        workspace: 'rw_5678abcd',
        cloudUrl: 'https://cloud.example.test',
        io: createBufferedIO(),
        noPrompt: true
      }),
      { token: 'ci-token', workspace: 'rw_5678abcd' }
    );
  });
});

test('legacy active workspace pointer functions are inert', async () => {
  await writeActiveWorkspace({
    workspace: 'stale',
    workspaceId: 'stale-id',
    workspaceSlug: 'stale',
    cloudUrl: 'https://cloud.example.test'
  });
  assert.equal(await readActiveWorkspace(), null);
  await clearActiveWorkspace();
  assert.equal(await readActiveWorkspace(), null);
});

test('legacy workspace token reads never return shadow credentials', async () => {
  assert.equal(await loadWorkspaceToken('stale'), null);
  assert.equal(await loadActiveWorkspaceToken(), null);
});

test('legacy workspace token writes are rejected and clears are inert', async () => {
  await assert.rejects(
    storeWorkspaceToken({ workspace: 'stale', token: 'tok' }),
    /canonical agent-relay cloud session/
  );
  await assert.rejects(
    writeStoredWorkspaceToken({ workspace: 'stale', token: 'tok' }),
    /canonical agent-relay cloud session/
  );
  await clearStoredWorkspaceToken('stale');
});
