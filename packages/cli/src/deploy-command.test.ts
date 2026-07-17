import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  configureDeployCommandForTest,
  formatDeployFailure,
  parseDeployArgs,
  runLogin,
  runLogout,
  withDefaultDeployMode
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

test('authored-source deploy failures identify the selected CLI version and source', () => {
  const message = formatDeployFailure(
    '/tmp/review/persona.ts',
    new SyntaxError('Unexpected token e in JSON at position 0')
  );

  assert.match(message, /agentworkforce deploy failed: Unexpected token e in JSON/);
  assert.match(message, /authored-source CLI: @agentworkforce\/cli \d+\.\d+\.\d+ from /);
  assert.match(message, /packages\/cli\/package\.json/);
  assert.match(message, /stale agentworkforce binary is ahead on PATH/);
  assert.match(message, /command -v agentworkforce && agentworkforce --version/);
  assert.match(message, /npm install -g agentworkforce@latest/);
});

test('JSON deploy failures do not imply that the selected CLI is stale', () => {
  const message = formatDeployFailure('/tmp/review/persona.json', new Error('invalid intent'));
  assert.equal(message, 'agentworkforce deploy failed: invalid intent');
});

test('non-interactive deploy without --mode defaults to cloud (#158)', () => {
  const parsed = parseDeployArgs(['/tmp/review/persona.ts', '--no-prompt']);
  assert.equal(parsed.mode, undefined);
  assert.equal(withDefaultDeployMode(parsed).mode, 'cloud');
});

test('runLogin uses cloud SDK auth, picks a workspace, and pins the canonical relay workspace key', async () => {
  const calls: string[] = [];
  const pinned: unknown[] = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureCloudSession: async (options?: { apiUrl?: string }) => {
      const apiUrl = options?.apiUrl ?? 'https://cloud.example.test';
      calls.push(`ensure:${apiUrl}`);
      return {
        auth: {
          apiUrl,
          accessToken: 'access',
          refreshToken: 'refresh',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
        },
        client: { fetch: async () => new Response(null, { status: 500 }) }
      };
    },
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          calls.push(`fetch:${pathname}`);
          if (pathname === '/api/v1/workspaces/ws-1/resolve') {
            return new Response(JSON.stringify({
              key: 'rk_live_acme',
              workspaceId: 'rw_1234abcd',
              relaycastWorkspaceId: 'rw_1234abcd',
              relayfileWorkspaceId: 'rf_acme',
              relayauthWorkspaceId: 'ra_acme',
              slug: 'acme',
              name: 'Acme'
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          return new Response(JSON.stringify({ workspaces: [{ id: 'ws-1', slug: 'acme' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    setWorkspaceKey: (name: string, key: string) => {
      pinned.push({ name, key });
    }
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://cloud.example.test/']);
    assert.deepEqual(trap.exits, [0]);
    assert.deepEqual(calls, [
      'ensure:https://cloud.example.test',
      'fetch:/api/v1/workspaces',
      'fetch:/api/v1/workspaces/ws-1/resolve'
    ]);
    assert.deepEqual(pinned, [{ name: 'Acme', key: 'rk_live_acme' }]);
    assert.match(trap.stdout, /logged in: Acme/);
  } finally {
    trap.restore();
    restoreDeps();
  }
});

test('runLogin with --workspace skips the workspaces list and pins the resolved relay workspace key', async () => {
  const calls: string[] = [];
  const pinned: unknown[] = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureCloudSession: async (options?: { apiUrl?: string }) => {
      const apiUrl = options?.apiUrl ?? 'https://cloud.example.test';
      calls.push(`ensure:${apiUrl}`);
      return {
        auth: {
          apiUrl,
          accessToken: 'access',
          refreshToken: 'refresh',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
        },
        client: { fetch: async () => new Response(null, { status: 500 }) }
      };
    },
    createCloudApiClient() {
      calls.push('createCloudApiClient');
      return {
        async fetch(pathname: string) {
          calls.push(`fetch:${pathname}`);
          return new Response(JSON.stringify({
            key: 'rk_live_direct',
            workspaceId: 'rw_5678abcd',
            relaycastWorkspaceId: 'rw_5678abcd',
            relayfileWorkspaceId: 'rf_direct',
            relayauthWorkspaceId: 'ra_direct'
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    setWorkspaceKey: (name: string, key: string) => {
      pinned.push({ name, key });
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
    assert.deepEqual(calls, [
      'ensure:https://cloud.example.test',
      'createCloudApiClient',
      'fetch:/api/v1/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/resolve'
    ]);
    assert.deepEqual(pinned, [{
      name: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
      key: 'rk_live_direct'
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
    ensureCloudSession: async (options?: { apiUrl?: string }) => ({
      auth: {
        apiUrl: options?.apiUrl ?? 'https://cloud.example.test',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      },
      client: { fetch: async () => new Response(null, { status: 500 }) }
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
    setWorkspaceKey: () => {
      throw new Error('setWorkspaceKey should not be called when listing fails');
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
    ensureCloudSession: async (options?: { apiUrl?: string }) => ({
      auth: {
        apiUrl: options?.apiUrl ?? 'https://cloud.example.test',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      },
      client: { fetch: async () => new Response(null, { status: 500 }) }
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
    setWorkspaceKey: () => {
      throw new Error('setWorkspaceKey should not be called when no workspaces');
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

test('runLogout preserves shared cloud auth and clears compatibility workspace state by default', async () => {
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

test('parseDeployArgs: --reconnect is repeatable and comma-aware', () => {
  const parsed = parseDeployArgs([
    './persona.json',
    '--reconnect',
    'slack,github',
    '--reconnect=linear',
  ]);

  assert.deepEqual(parsed.reconnectProviders, ['slack', 'github', 'linear']);
});

test('parseDeployArgs: --harness-source managed is accepted', () => {
  const parsed = parseDeployArgs(['./persona.json', '--harness-source', 'managed']);

  assert.equal(parsed.harnessSource, 'managed');
});

test('parseDeployArgs: legacy --harness-source plan normalizes to managed', () => {
  const parsed = parseDeployArgs(['./persona.json', '--harness-source=plan']);

  assert.equal(parsed.harnessSource, 'managed');
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

test('runLogin canonicalizes origin.agentrelay.cloud apiUrl before resolving the workspace', async () => {
  const calls: string[] = [];
  const restoreDeps = configureDeployCommandForTest({
    createTerminalIO: () => createBufferedIO(),
    ensureCloudSession: async () => ({
      auth: {
        apiUrl: 'https://origin.agentrelay.cloud',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
      },
      client: { fetch: async () => new Response(null, { status: 500 }) }
    }),
    createCloudApiClient(_auth, apiUrl) {
      calls.push(`client:${apiUrl}`);
      return {
        async fetch(pathname: string) {
          calls.push(`fetch:${pathname}`);
          if (pathname === '/api/v1/workspaces/ws-1/resolve') {
            return new Response(JSON.stringify({
              key: 'rk_live_acme',
              workspaceId: 'rw_1234abcd',
              relaycastWorkspaceId: 'rw_1234abcd',
              relayfileWorkspaceId: 'rf_acme',
              relayauthWorkspaceId: 'ra_acme'
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          return new Response(JSON.stringify({ workspaces: [{ id: 'ws-1', slug: 'acme' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      };
    },
    setWorkspaceKey: () => {}
  });
  const trap = trapExit(false);
  try {
    await runLogin(['--cloud-url', 'https://agentrelay.com/cloud']);
    assert.deepEqual(trap.exits, [0]);
    assert.ok(calls.every((call) => !call.includes('origin.agentrelay.cloud')), calls.join('\n'));
    assert.ok(calls.includes('client:https://agentrelay.com/cloud'));
  } finally {
    trap.restore();
    restoreDeps();
  }
});
