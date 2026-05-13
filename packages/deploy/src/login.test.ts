import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearStoredWorkspaceToken,
  loadWorkspaceToken,
  resolveWorkspaceToken,
  writeStoredWorkspaceToken
} from './login.js';
import { createBufferedIO } from './io.js';

async function withLoginEnv<T>(
  env: {
    loginFile?: string;
    workspaceId?: string;
    workspaceToken?: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  const previous = {
    WORKFORCE_LOGIN_FILE: process.env.WORKFORCE_LOGIN_FILE,
    WORKFORCE_DISABLE_KEYCHAIN: process.env.WORKFORCE_DISABLE_KEYCHAIN,
    WORKFORCE_WORKSPACE_ID: process.env.WORKFORCE_WORKSPACE_ID,
    WORKFORCE_WORKSPACE_TOKEN: process.env.WORKFORCE_WORKSPACE_TOKEN
  };
  process.env.WORKFORCE_DISABLE_KEYCHAIN = '1';
  if (env.loginFile === undefined) delete process.env.WORKFORCE_LOGIN_FILE;
  else process.env.WORKFORCE_LOGIN_FILE = env.loginFile;
  if (env.workspaceId === undefined) delete process.env.WORKFORCE_WORKSPACE_ID;
  else process.env.WORKFORCE_WORKSPACE_ID = env.workspaceId;
  if (env.workspaceToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
  else process.env.WORKFORCE_WORKSPACE_TOKEN = env.workspaceToken;

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

test('workspace token store writes and reads the active workspace token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-login-store-'));
  const loginFile = path.join(dir, 'login.json');
  try {
    await withLoginEnv({ loginFile }, async () => {
      await writeStoredWorkspaceToken({
        workspaceSlug: 'acme',
        workspaceId: 'ws-123',
        token: 'tok-stored',
        cloudUrl: 'https://cloud.example.test'
      });
      const raw = JSON.parse(await readFile(loginFile, 'utf8')) as Record<string, unknown>;
      assert.equal(raw.workspace, 'acme');
      assert.equal(raw.workspaceId, 'ws-123');
      assert.equal(raw.token, 'tok-stored');
      assert.equal((await loadWorkspaceToken('acme'))?.token, 'tok-stored');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken prefers env token before stored login', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-login-precedence-'));
  const loginFile = path.join(dir, 'login.json');
  try {
    await withLoginEnv({ loginFile }, async () => {
      await writeStoredWorkspaceToken({ workspace: 'stored', token: 'tok-stored' });
    });
    await withLoginEnv({
      loginFile,
      workspaceId: 'env-ws',
      workspaceToken: 'tok-env'
    }, async () => {
      assert.deepEqual(
        await resolveWorkspaceToken({
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO()
        }),
        { token: 'tok-env', workspace: 'env-ws' }
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken reads stored token and fails clearly with --no-prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-login-resolve-'));
  const loginFile = path.join(dir, 'login.json');
  try {
    await withLoginEnv({ loginFile }, async () => {
      await writeStoredWorkspaceToken({ workspace: 'stored', token: 'tok-stored' });
      assert.deepEqual(
        await resolveWorkspaceToken({
          workspace: 'stored',
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        }),
        { token: 'tok-stored', workspace: 'stored' }
      );
    });
    await withLoginEnv({ loginFile: path.join(dir, 'missing.json') }, async () => {
      await assert.rejects(
        resolveWorkspaceToken({
          workspace: 'missing',
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        }),
        /run `agentworkforce login`/
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearStoredWorkspaceToken removes the stored token file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-login-clear-'));
  const loginFile = path.join(dir, 'login.json');
  try {
    await withLoginEnv({ loginFile }, async () => {
      await writeStoredWorkspaceToken({ workspace: 'stored', token: 'tok-stored' });
      await clearStoredWorkspaceToken('stored');
      assert.equal(await loadWorkspaceToken('stored'), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
