import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

async function withCloudSessionEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    WORKFORCE_WORKSPACE_ID: process.env.WORKFORCE_WORKSPACE_ID,
    WORKFORCE_WORKSPACE_TOKEN: process.env.WORKFORCE_WORKSPACE_TOKEN,
    CLOUD_API_ACCESS_TOKEN: process.env.CLOUD_API_ACCESS_TOKEN,
    CLOUD_API_REFRESH_TOKEN: process.env.CLOUD_API_REFRESH_TOKEN,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT,
    CLOUD_API_URL: process.env.CLOUD_API_URL
  };
  delete process.env.WORKFORCE_WORKSPACE_ID;
  delete process.env.WORKFORCE_WORKSPACE_TOKEN;
  process.env.CLOUD_API_URL = 'https://cloud.example.test';
  process.env.CLOUD_API_ACCESS_TOKEN = 'cloud-access';
  process.env.CLOUD_API_REFRESH_TOKEN = 'cloud-refresh';
  process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = '2999-01-01T00:00:00.000Z';
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

function withTrappedFetch(handler: typeof fetch): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = previous;
  };
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
      { token: 'ci-token', workspace: 'rw_1234abcd', authSource: 'env' }
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
      { token: 'ci-token', workspace: 'rw_5678abcd', authSource: 'env' }
    );
  });
});

test('resolveWorkspaceToken fails clearly when workspace resolve returns non-JSON', async () => {
  await withCloudSessionEnv(async () => {
    const restoreFetch = withTrappedFetch(async () =>
      new Response('', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    try {
      await assert.rejects(
        resolveWorkspaceToken({
          workspace: 'rw_badjson',
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        }),
        /workspace resolve returned an invalid descriptor/
      );
    } finally {
      restoreFetch();
    }
  });
});

test('resolveWorkspaceToken without a cloud session fails with login guidance', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-no-cloud-session-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AGENT_RELAY_HOME: path.join(home, '.agentworkforce', 'relay')
  };
  delete env.WORKFORCE_WORKSPACE_ID;
  delete env.WORKFORCE_WORKSPACE_TOKEN;
  delete env.CLOUD_API_URL;
  delete env.CLOUD_API_ACCESS_TOKEN;
  delete env.CLOUD_API_REFRESH_TOKEN;
  delete env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const { resolveWorkspaceToken } = await import('./dist/login.js');
          const { createBufferedIO } = await import('./dist/io.js');
          try {
            await resolveWorkspaceToken({
              cloudUrl: 'https://cloud.example.test',
              io: createBufferedIO(),
              noPrompt: true
            });
            process.exit(2);
          } catch (error) {
            process.stderr.write(error instanceof Error ? error.message : String(error));
          }
        `
      ],
      { cwd: process.cwd(), env, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Cloud login required/);
    assert.match(result.stderr, /agent-relay login/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
