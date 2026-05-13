import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  configureDeployCommandForTest,
  parseDeployArgs,
  runLogin,
  runLogout
} from './deploy-command.js';
import { createBufferedIO } from '@agentworkforce/deploy';

interface ExitTrap {
  exits: number[];
  stdout: string;
  stderr: string;
  restore: () => void;
}

function trapExit(throwOnExit = true): ExitTrap {
  const trap: ExitTrap = {
    exits: [],
    stdout: '',
    stderr: '',
    restore: () => {
      /* replaced below */
    }
  };
  const origExit = process.exit;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const fakeExit = ((code?: number) => {
    trap.exits.push(code ?? 0);
    if (throwOnExit) {
      throw new Error(`__exit_trap__:${code ?? 0}`);
    }
    return undefined as never;
  }) as typeof process.exit;

  process.exit = fakeExit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    trap.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    trap.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  trap.restore = () => {
    process.exit = origExit;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
  return trap;
}

test('runLogin uses cloud SDK auth, picks a workspace, and writes the active pointer (no token mint)', async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureAuthenticated: async (apiUrl: string) => {
      calls.push(`ensure:${apiUrl}`);
      return {
        apiUrl,
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      };
    },
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          calls.push(`fetch:${pathname}`);
          return new Response(JSON.stringify({ workspaces: [{ id: 'ws-1', slug: 'acme' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    writeActiveWorkspace: async (pointer: unknown) => {
      writes.push(pointer);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://cloud.example.test/']);
    assert.deepEqual(trap.exits, [0]);
    assert.deepEqual(calls, [
      'ensure:https://cloud.example.test',
      'fetch:/api/v1/workspaces'
    ]);
    assert.deepEqual(writes, [{
      workspace: 'acme',
      workspaceSlug: 'acme',
      workspaceId: 'ws-1',
      cloudUrl: 'https://cloud.example.test'
    }]);
    assert.match(trap.stdout, /logged in: acme/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogin with --workspace skips the workspaces list, skips token mint, writes active pointer', async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureAuthenticated: async (apiUrl: string) => {
      calls.push(`ensure:${apiUrl}`);
      return {
        apiUrl,
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      };
    },
    createCloudApiClient() {
      calls.push('createCloudApiClient');
      return {
        async fetch(pathname: string) {
          calls.push(`fetch:${pathname}`);
          return new Response('should not be called', { status: 500 });
        }
      };
    },
    writeActiveWorkspace: async (pointer: unknown) => {
      writes.push(pointer);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin([
      '--cloud-url',
      'https://cloud.example.test/',
      '--workspace',
      '50587328-441d-4acb-b8f3-dbe1b3c5de99'
    ]);
    assert.deepEqual(trap.exits, [0]);
    assert.ok(
      !calls.some((c) => c === 'createCloudApiClient' || c.startsWith('fetch:')),
      `expected workspace-list to be skipped, got calls: ${JSON.stringify(calls)}`
    );
    assert.deepEqual(calls, ['ensure:https://cloud.example.test']);
    assert.deepEqual(writes, [{
      workspace: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      cloudUrl: 'https://cloud.example.test'
    }]);
    assert.match(trap.stdout, /logged in: 50587328-441d-4acb-b8f3-dbe1b3c5de99/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogin without --workspace surfaces a --workspace hint when the workspaces list returns 403', async () => {
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureAuthenticated: async (apiUrl: string) => ({
      apiUrl,
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(_pathname: string) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    writeActiveWorkspace: async () => {
      throw new Error('writeActiveWorkspace should not be called when listing fails');
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://cloud.example.test/']);
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /workspace list returned 403 Forbidden/);
    assert.match(trap.stderr, /Pass --workspace <id-or-slug> to skip listing/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogin without --workspace surfaces a no-workspaces message when the list comes back empty', async () => {
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureAuthenticated: async (apiUrl: string) => ({
      apiUrl,
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(_pathname: string) {
          return new Response(JSON.stringify({ workspaces: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    writeActiveWorkspace: async () => {
      throw new Error('writeActiveWorkspace should not be called when no workspaces');
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://cloud.example.test/']);
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /no workspaces are accessible from this account/);
    assert.match(trap.stderr, /pass --workspace <id-or-slug>/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogout preserves shared cloud auth and clears the active pointer + legacy keychain token by default', async () => {
  const calls: string[] = [];
  const restoreDeps = configureDeployCommandForTest({
    clearStoredAuth: async () => {
      calls.push('clear-auth');
    },
    clearActiveWorkspace: async () => {
      calls.push('clear-active');
    },
    clearStoredWorkspaceToken: async (workspace?: string) => {
      calls.push(`clear-workspace:${workspace ?? ''}`);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogout(['--workspace', 'acme']);
    assert.deepEqual(trap.exits, [0]);
    assert.deepEqual(calls, ['clear-active', 'clear-workspace:acme']);
    assert.match(trap.stdout, /workspace login cleared/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogout clears shared cloud auth + active pointer when --cloud-auth is passed', async () => {
  const calls: string[] = [];
  const restoreDeps = configureDeployCommandForTest({
    clearStoredAuth: async () => {
      calls.push('clear-auth');
    },
    clearActiveWorkspace: async () => {
      calls.push('clear-active');
    },
    clearStoredWorkspaceToken: async (workspace?: string) => {
      calls.push(`clear-workspace:${workspace ?? ''}`);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogout(['--workspace', 'acme', '--cloud-auth']);
    assert.deepEqual(trap.exits, [0]);
    assert.deepEqual(calls, ['clear-auth', 'clear-active', 'clear-workspace:acme']);
    assert.match(trap.stdout, /logged out/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogout treats --all as an alias for clearing shared cloud auth + active pointer', async () => {
  const calls: string[] = [];
  const restoreDeps = configureDeployCommandForTest({
    clearStoredAuth: async () => {
      calls.push('clear-auth');
    },
    clearActiveWorkspace: async () => {
      calls.push('clear-active');
    },
    clearStoredWorkspaceToken: async (workspace?: string) => {
      calls.push(`clear-workspace:${workspace ?? ''}`);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogout(['--all']);
    assert.deepEqual(trap.exits, [0]);
    assert.deepEqual(calls, ['clear-auth', 'clear-active', 'clear-workspace:']);
    assert.match(trap.stdout, /logged out/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('parseDeployArgs: single --input parses and forwards', () => {
  const parsed = parseDeployArgs(['./persona.json', '--input', 'TOPIC=Deploy v1']);

  assert.equal(parsed.personaPath, path.resolve('./persona.json'));
  assert.deepEqual(parsed.inputs, { TOPIC: 'Deploy v1' });
});

test('parseDeployArgs: multiple --input flags accumulate', () => {
  const parsed = parseDeployArgs([
    './persona.json',
    '--input',
    'TOPIC=Deploy v1',
    '--input=REGION=us-east-1'
  ]);

  assert.deepEqual(parsed.inputs, {
    TOPIC: 'Deploy v1',
    REGION: 'us-east-1'
  });
});

test('parseDeployArgs: malformed --input exits with clean error', () => {
  const trap = trapExit();
  try {
    assert.throws(
      () => parseDeployArgs(['./persona.json', '--input', 'foo']),
      /__exit_trap__:1/
    );
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /--input: expected <key>=<value>; got "foo"/);
  } finally {
    trap.restore();
  }
});

test('runLogin canonicalizes origin.agentrelay.cloud apiUrl before persisting active.json', async () => {
  // ensureAuthenticated occasionally returns auth.apiUrl pointing at the
  // SST origin-bypass hostname. If we persist that, every subsequent API
  // call 401s because session cookies don't cross subdomains. The CLI
  // must canonicalize before writing.
  const writes: Array<{ cloudUrl?: string }> = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureAuthenticated: async () => ({
      apiUrl: 'https://origin.agentrelay.cloud',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(_pathname: string) {
          return new Response(JSON.stringify({ workspaces: [{ id: 'ws-1', slug: 'acme' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    writeActiveWorkspace: async (pointer: { cloudUrl?: string }) => {
      writes.push(pointer);
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://agentrelay.com/cloud']);
    assert.deepEqual(trap.exits, [0]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].cloudUrl, 'https://agentrelay.com/cloud');
  } finally {
    trap.restore();
    restoreDeps();
  }
});
