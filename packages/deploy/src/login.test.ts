import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearActiveWorkspace,
  clearStoredWorkspaceToken,
  loadWorkspaceToken,
  readActiveWorkspace,
  resolveWorkspaceToken,
  writeActiveWorkspace,
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
  const activeFile = path.join(dir, 'active.json');
  try {
    // Suppress the shared-auth tier (Tier 2) so the legacy keychain path
    // (Tier 3) is exercised — otherwise a real ~/.agent-relay login on
    // the dev's machine satisfies Tier 2 first and the assertion flips.
    await withActiveWorkspaceEnv({ activeFile, sharedAuth: null }, async () => {
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

// ---------------------------------------------------------------------------
// active.json pointer + shared-auth resolution tier
// ---------------------------------------------------------------------------

/**
 * Back up the real ~/.agent-relay/cloud-auth.json (if present) for the
 * duration of a test, so we can install a controlled fixture or assert
 * "no shared auth" without flaking on machines where the dev has already
 * logged into agent-relay. `AUTH_FILE_PATH` in `@agent-relay/cloud` is
 * computed once at import time from `os.homedir()`, so there's no env
 * knob to redirect it — backing up the actual file is the cleanest hook.
 */
const SHARED_AUTH_FILE = path.join(os.homedir(), '.agent-relay', 'cloud-auth.json');

async function withActiveWorkspaceEnv<T>(
  env: {
    activeFile?: string;
    /**
     * Shared @agent-relay/cloud auth fixture. When non-null, the test
     * writes it to ~/.agent-relay/cloud-auth.json. When null, the test
     * makes sure that file is absent. The real user's file (if any) is
     * backed up and restored.
     */
    sharedAuth?: {
      accessToken: string;
      refreshToken?: string;
      accessTokenExpiresAt?: string;
      apiUrl?: string;
    } | null;
  },
  fn: () => Promise<T>
): Promise<T> {
  const previous = {
    WORKFORCE_ACTIVE_WORKSPACE_FILE: process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE,
    CLOUD_API_URL: process.env.CLOUD_API_URL,
    CLOUD_API_ACCESS_TOKEN: process.env.CLOUD_API_ACCESS_TOKEN,
    CLOUD_API_REFRESH_TOKEN: process.env.CLOUD_API_REFRESH_TOKEN,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT
  };
  // Clear CLOUD_API_* env vars so readEnvAuth() doesn't shortcut past our
  // file-based fixture — every test exercises the on-disk path explicitly.
  delete process.env.CLOUD_API_URL;
  delete process.env.CLOUD_API_ACCESS_TOKEN;
  delete process.env.CLOUD_API_REFRESH_TOKEN;
  delete process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT;

  if (env.activeFile === undefined) delete process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE;
  else process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = env.activeFile;

  // Back up the real shared-auth file so we can swap in a fixture (or
  // assert absence) without nuking the dev's actual agent-relay login.
  const existingAuth = await readFile(SHARED_AUTH_FILE, 'utf8').catch(() => null);
  if (existingAuth !== null) {
    await rm(SHARED_AUTH_FILE, { force: true });
  }

  if (env.sharedAuth) {
    await mkdir(path.dirname(SHARED_AUTH_FILE), { recursive: true, mode: 0o700 });
    await writeFile(
      SHARED_AUTH_FILE,
      JSON.stringify({
        apiUrl: env.sharedAuth.apiUrl ?? 'https://cloud.example.test',
        accessToken: env.sharedAuth.accessToken,
        refreshToken: env.sharedAuth.refreshToken ?? 'refresh-token',
        accessTokenExpiresAt:
          env.sharedAuth.accessTokenExpiresAt ?? '2999-01-01T00:00:00.000Z'
      }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
  }

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
    // Always restore the real shared-auth file (or remove our fixture).
    if (existingAuth !== null) {
      await mkdir(path.dirname(SHARED_AUTH_FILE), { recursive: true, mode: 0o700 });
      await writeFile(SHARED_AUTH_FILE, existingAuth, { encoding: 'utf8', mode: 0o600 });
    } else {
      await rm(SHARED_AUTH_FILE, { force: true });
    }
  }
}

test('writeActiveWorkspace + readActiveWorkspace round-trip the pointer file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-active-rt-'));
  const activeFile = path.join(dir, 'active.json');
  try {
    await withActiveWorkspaceEnv({ activeFile, sharedAuth: null }, async () => {
      assert.equal(await readActiveWorkspace(), null);
      await writeActiveWorkspace({
        workspace: 'acme',
        workspaceSlug: 'acme',
        workspaceId: 'ws-1',
        cloudUrl: 'https://cloud.example.test'
      });
      const raw = JSON.parse(await readFile(activeFile, 'utf8')) as Record<string, unknown>;
      assert.equal(raw.workspace, 'acme');
      assert.equal(raw.workspaceId, 'ws-1');
      assert.equal(raw.cloudUrl, 'https://cloud.example.test');
      assert.ok(typeof raw.setAt === 'string' && raw.setAt.length > 0);
      const read = await readActiveWorkspace();
      assert.equal(read?.workspace, 'acme');
      assert.equal(read?.workspaceId, 'ws-1');
      assert.equal(read?.cloudUrl, 'https://cloud.example.test');
      await clearActiveWorkspace();
      assert.equal(await readActiveWorkspace(), null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken returns shared accessToken as Bearer when active.json + shared auth are present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-resolve-shared-'));
  const activeFile = path.join(dir, 'active.json');
  const loginFile = path.join(dir, 'login.json'); // empty — no legacy fallback
  try {
    await withActiveWorkspaceEnv({
      activeFile,
      sharedAuth: {
        accessToken: 'shared-access',
        refreshToken: 'shared-refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      }
    }, async () => {
      await withLoginEnv({ loginFile }, async () => {
        await writeActiveWorkspace({
          workspace: 'acme',
          workspaceSlug: 'acme',
          workspaceId: 'ws-1',
          cloudUrl: 'https://cloud.example.test'
        });
        const resolved = await resolveWorkspaceToken({
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        });
        assert.equal(resolved.token, 'shared-access');
        assert.equal(resolved.workspace, 'acme');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken falls back to the legacy keychain path when active.json is absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-resolve-legacy-'));
  const activeFile = path.join(dir, 'active.json'); // never written
  const loginFile = path.join(dir, 'login.json');
  try {
    await withActiveWorkspaceEnv({ activeFile, sharedAuth: null }, async () => {
      await withLoginEnv({ loginFile }, async () => {
        await writeStoredWorkspaceToken({
          workspace: 'legacy-ws',
          token: 'legacy-token'
        });
        const resolved = await resolveWorkspaceToken({
          workspace: 'legacy-ws',
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        });
        assert.equal(resolved.token, 'legacy-token');
        assert.equal(resolved.workspace, 'legacy-ws');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken throws clear-instructions error when nothing is configured', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-resolve-empty-'));
  const activeFile = path.join(dir, 'active.json'); // never written
  const loginFile = path.join(dir, 'login.json');   // never written
  try {
    await withActiveWorkspaceEnv({ activeFile, sharedAuth: null }, async () => {
      await withLoginEnv({ loginFile }, async () => {
        await assert.rejects(
          resolveWorkspaceToken({
            workspace: 'nothing',
            cloudUrl: 'https://cloud.example.test',
            io: createBufferedIO(),
            noPrompt: true
          }),
          /run `agentworkforce login`/
        );
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken prefers WORKFORCE_WORKSPACE_TOKEN env over shared-auth tier', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-resolve-env-'));
  const activeFile = path.join(dir, 'active.json');
  const loginFile = path.join(dir, 'login.json');
  try {
    await withActiveWorkspaceEnv({
      activeFile,
      sharedAuth: {
        accessToken: 'shared-access',
        refreshToken: 'shared-refresh'
      }
    }, async () => {
      await withLoginEnv({
        loginFile,
        workspaceId: 'env-ws',
        workspaceToken: 'env-token'
      }, async () => {
        await writeActiveWorkspace({ workspace: 'active-ws', cloudUrl: 'https://cloud.example.test' });
        const resolved = await resolveWorkspaceToken({
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO()
        });
        assert.equal(resolved.token, 'env-token');
        assert.equal(resolved.workspace, 'env-ws');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkspaceToken uses requested workspace arg even when active.json has a different value', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-resolve-arg-'));
  const activeFile = path.join(dir, 'active.json');
  const loginFile = path.join(dir, 'login.json');
  try {
    await withActiveWorkspaceEnv({
      activeFile,
      sharedAuth: {
        accessToken: 'shared-access',
        refreshToken: 'shared-refresh'
      }
    }, async () => {
      await withLoginEnv({ loginFile }, async () => {
        await writeActiveWorkspace({
          workspace: 'default-ws',
          workspaceSlug: 'default-ws',
          cloudUrl: 'https://cloud.example.test'
        });
        const resolved = await resolveWorkspaceToken({
          workspace: 'override-ws',
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO(),
          noPrompt: true
        });
        assert.equal(resolved.token, 'shared-access');
        assert.equal(resolved.workspace, 'override-ws');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
