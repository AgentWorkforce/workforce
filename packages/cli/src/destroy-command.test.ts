import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDestroyArgs, runDestroy } from './destroy-command.js';

interface ExitTrap {
  exits: number[];
  stderr: string;
  stdout: string;
  restore: () => void;
}

function trapIO(): ExitTrap {
  const trap: ExitTrap = {
    exits: [],
    stderr: '',
    stdout: '',
    restore: () => {
      /* replaced below */
    }
  };
  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  const fakeExit = ((code?: number) => {
    trap.exits.push(code ?? 0);
    throw new Error(`__exit_trap__:${code ?? 0}`);
  }) as typeof process.exit;

  process.exit = fakeExit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    trap.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    trap.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  trap.restore = () => {
    process.exit = origExit;
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  };
  return trap;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function trapFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: FetchCall = { url, init };
    calls.push(call);
    return await handler(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    }
  };
}

function withTokenEnv(token: string, workspace: string): () => void {
  const restoreIsolate = isolateAuthFiles();
  const prevToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  const prevWs = process.env.WORKFORCE_WORKSPACE_ID;
  const prevCloudA = process.env.WORKFORCE_DEPLOY_CLOUD_URL;
  const prevCloudB = process.env.WORKFORCE_CLOUD_URL;
  process.env.WORKFORCE_WORKSPACE_TOKEN = token;
  process.env.WORKFORCE_WORKSPACE_ID = workspace;
  delete process.env.WORKFORCE_DEPLOY_CLOUD_URL;
  delete process.env.WORKFORCE_CLOUD_URL;
  return () => {
    if (prevToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    else process.env.WORKFORCE_WORKSPACE_TOKEN = prevToken;
    if (prevWs === undefined) delete process.env.WORKFORCE_WORKSPACE_ID;
    else process.env.WORKFORCE_WORKSPACE_ID = prevWs;
    if (prevCloudA !== undefined) process.env.WORKFORCE_DEPLOY_CLOUD_URL = prevCloudA;
    if (prevCloudB !== undefined) process.env.WORKFORCE_CLOUD_URL = prevCloudB;
    restoreIsolate();
  };
}

/**
 * Pin every filesystem-backed auth source to definitely-missing/disabled
 * paths so the destroy CLI tests don't accidentally pick up the host
 * developer's `~/.agentworkforce/active.json` or `~/.agent-relay/cloud-auth.json`.
 * Tests that intentionally exercise the active.json fallback override
 * `WORKFORCE_ACTIVE_WORKSPACE_FILE` after this runs.
 */
function isolateAuthFiles(): () => void {
  const prevActive = process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE;
  const prevLogin = process.env.WORKFORCE_LOGIN_FILE;
  const prevDisable = process.env.WORKFORCE_DISABLE_SHARED_AUTH;
  process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = path.join(os.tmpdir(), 'wf-destroy-test-active-MISSING.json');
  process.env.WORKFORCE_LOGIN_FILE = path.join(os.tmpdir(), 'wf-destroy-test-login-MISSING.json');
  process.env.WORKFORCE_DISABLE_SHARED_AUTH = '1';
  return () => {
    if (prevActive === undefined) delete process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE;
    else process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = prevActive;
    if (prevLogin === undefined) delete process.env.WORKFORCE_LOGIN_FILE;
    else process.env.WORKFORCE_LOGIN_FILE = prevLogin;
    if (prevDisable === undefined) delete process.env.WORKFORCE_DISABLE_SHARED_AUTH;
    else process.env.WORKFORCE_DISABLE_SHARED_AUTH = prevDisable;
  };
}

const AGENT_UUID = '11111111-2222-4333-8444-555555555555';
const WORKSPACE = 'ws-test';
const CLOUD = 'https://cloud.example.test';

test('parseDestroyArgs: positional agent uuid only', () => {
  const parsed = parseDestroyArgs([AGENT_UUID]);
  assert.equal(parsed.target, AGENT_UUID);
  assert.equal(parsed.workspace, undefined);
  assert.equal(parsed.cloudUrl, undefined);
  assert.equal(parsed.noPrompt, undefined);
});

test('parseDestroyArgs: persona path positional + flags', () => {
  const parsed = parseDestroyArgs([
    './weekly.json',
    '--workspace',
    'ws-1',
    '--cloud-url=https://c.test',
    '--no-prompt'
  ]);
  assert.equal(parsed.target, './weekly.json');
  assert.equal(parsed.workspace, 'ws-1');
  assert.equal(parsed.cloudUrl, 'https://c.test');
  assert.equal(parsed.noPrompt, true);
});

test('parseDestroyArgs: missing positional exits 1', () => {
  const trap = trapIO();
  try {
    assert.throws(() => parseDestroyArgs(['--workspace', 'ws-1']), /__exit_trap__:1/);
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /missing persona path or agent id/);
  } finally {
    trap.restore();
  }
});

test('parseDestroyArgs: unknown flag exits 1', () => {
  const trap = trapIO();
  try {
    assert.throws(() => parseDestroyArgs([AGENT_UUID, '--bogus']), /__exit_trap__:1/);
    assert.match(trap.stderr, /unknown flag "--bogus"/);
  } finally {
    trap.restore();
  }
});

test('runDestroy: happy path with agent UUID positional', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const fetchTrap = trapFetch(async (call) => {
    assert.equal(
      call.url,
      `${CLOUD}/api/v1/workspaces/${WORKSPACE}/deployments/${AGENT_UUID}`
    );
    assert.equal(call.init?.method, 'DELETE');
    assert.equal(
      (call.init?.headers as Record<string, string> | undefined)?.authorization,
      'Bearer tok-1'
    );
    return new Response(
      JSON.stringify({
        agentId: AGENT_UUID,
        status: 'destroyed',
        destroyedAt: '2026-05-13T00:00:00.000Z',
        cancelledScheduleIds: ['sched_a', 'sched_b']
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([AGENT_UUID, '--cloud-url', CLOUD]),
      /__exit_trap__:0/
    );
    assert.deepEqual(trap.exits, [0]);
    assert.match(trap.stdout, new RegExp(`destroyed: ${AGENT_UUID}`));
    assert.match(trap.stdout, /cancelled schedules: 2/);
    assert.equal(fetchTrap.calls.length, 1);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
  }
});

test('runDestroy: 404 maps to exit 2 (not-found / already destroyed)', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const fetchTrap = trapFetch(
    async () =>
      new Response(JSON.stringify({ error: 'Agent not found', code: 'agent_not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
  );
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([AGENT_UUID, '--cloud-url', CLOUD]),
      /__exit_trap__:2/
    );
    assert.deepEqual(trap.exits, [2]);
    assert.match(trap.stderr, /agent not found or already destroyed/);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
  }
});

test('runDestroy: 401 maps to exit 1 with a login hint', async () => {
  const restoreEnv = withTokenEnv('tok-bad', WORKSPACE);
  const fetchTrap = trapFetch(
    async () =>
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
  );
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([AGENT_UUID, '--cloud-url', CLOUD]),
      /__exit_trap__:1/
    );
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /unauthorized/i);
    assert.match(trap.stderr, /workforce login/i);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
  }
});

test('runDestroy: missing workspace exits 1', async () => {
  // No WORKFORCE_WORKSPACE_ID, no --workspace, and no on-disk auth state
  // — destroy should fail fast with an actionable error and never reach
  // the network. We isolate the filesystem sources because the new code
  // path also consults `~/.agentworkforce/active.json` and the shared
  // cloud-auth file, which would otherwise leak from the host machine
  // running the test.
  const restoreIsolate = isolateAuthFiles();
  const prevToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  const prevWs = process.env.WORKFORCE_WORKSPACE_ID;
  process.env.WORKFORCE_WORKSPACE_TOKEN = 'tok-1';
  delete process.env.WORKFORCE_WORKSPACE_ID;
  const fetchTrap = trapFetch(async () => {
    throw new Error('fetch must not be called when workspace is missing');
  });
  const trap = trapIO();
  try {
    await assert.rejects(runDestroy([AGENT_UUID, '--no-prompt']), /__exit_trap__:1/);
    assert.deepEqual(trap.exits, [1]);
    // Accept either the orchestrator-level message ("no workspace resolved")
    // or the auth-resolver message ("no workspace credentials resolved")
    // — both are valid pre-network failures.
    assert.match(trap.stderr, /no workspace (credentials )?resolved/);
    assert.equal(fetchTrap.calls.length, 0);
  } finally {
    trap.restore();
    fetchTrap.restore();
    if (prevToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    else process.env.WORKFORCE_WORKSPACE_TOKEN = prevToken;
    if (prevWs !== undefined) process.env.WORKFORCE_WORKSPACE_ID = prevWs;
    restoreIsolate();
  }
});

test('runDestroy: persona path resolves to agent id via /agents lookup', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-destroy-'));
  const personaPath = path.join(tmp, 'weekly-digest.json');
  await writeFile(
    personaPath,
    JSON.stringify({ id: 'weekly-digest', slug: 'weekly-digest', intent: 'review' }),
    'utf8'
  );

  const fetchTrap = trapFetch(async (call) => {
    if (call.url.includes('/agents?')) {
      assert.equal(
        call.url,
        `${CLOUD}/api/v1/workspaces/${WORKSPACE}/agents?persona_slug=weekly-digest`
      );
      assert.equal(call.init?.method, 'GET');
      return new Response(JSON.stringify({ agent: { id: AGENT_UUID } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    assert.equal(
      call.url,
      `${CLOUD}/api/v1/workspaces/${WORKSPACE}/deployments/${AGENT_UUID}`
    );
    assert.equal(call.init?.method, 'DELETE');
    return new Response(
      JSON.stringify({
        agentId: AGENT_UUID,
        status: 'destroyed',
        destroyedAt: '2026-05-13T00:00:00.000Z',
        cancelledScheduleIds: []
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([personaPath, '--cloud-url', CLOUD]),
      /__exit_trap__:0/
    );
    assert.deepEqual(trap.exits, [0]);
    assert.match(trap.stdout, new RegExp(`destroyed: ${AGENT_UUID}`));
    assert.match(trap.stdout, /cancelled schedules: 0/);
    assert.equal(fetchTrap.calls.length, 2);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runDestroy: directory target is not treated as a persona file', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-destroy-dir-'));
  const fetchTrap = trapFetch(async (call) => {
    assert.equal(
      call.url,
      `${CLOUD}/api/v1/workspaces/${WORKSPACE}/deployments/${encodeURIComponent(tmp)}`
    );
    assert.equal(call.init?.method, 'DELETE');
    return new Response(
      JSON.stringify({
        agentId: tmp,
        status: 'destroyed',
        destroyedAt: '2026-05-13T00:00:00.000Z',
        cancelledScheduleIds: []
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([tmp, '--cloud-url', CLOUD]),
      /__exit_trap__:0/
    );
    assert.deepEqual(trap.exits, [0]);
    assert.equal(fetchTrap.calls.length, 1);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runDestroy: persona path with no deployed agent returns exit 2', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-destroy-'));
  const personaPath = path.join(tmp, 'orphan.json');
  await writeFile(
    personaPath,
    JSON.stringify({ id: 'orphan', slug: 'orphan', intent: 'review' }),
    'utf8'
  );

  const fetchTrap = trapFetch(
    async () =>
      new Response('', { status: 404 })
  );
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([personaPath, '--cloud-url', CLOUD]),
      /__exit_trap__:2/
    );
    assert.deepEqual(trap.exits, [2]);
    assert.match(trap.stderr, /no deployed agent found for persona "orphan"/);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runDestroy: 5xx server error exits 1 and surfaces the status', async () => {
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const fetchTrap = trapFetch(
    async () => new Response('boom', { status: 500 })
  );
  const trap = trapIO();
  try {
    await assert.rejects(
      runDestroy([AGENT_UUID, '--cloud-url', CLOUD]),
      /__exit_trap__:1/
    );
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /500/);
  } finally {
    trap.restore();
    fetchTrap.restore();
    restoreEnv();
  }
});

test('runDestroy: HTML 404 body is replaced with a hint, not dumped verbatim', async () => {
  // Regression guard for the apex-without-/cloud bug: when the CLI hits
  // `agentrelay.com/api/...` instead of `agentrelay.com/cloud/api/...`,
  // cloud's marketing site returns a full Next.js 404 page. The error
  // formatter must summarize that, not dump it into stderr.
  const restoreEnv = withTokenEnv('tok-1', WORKSPACE);
  const htmlPage = '<!DOCTYPE html><html lang="en"><head>'
    + '<title>404</title>'
    + '<script src="/_next/static/chunks/main.js"></script>'.repeat(20)
    + '</head><body></body></html>';
  const fetchTrap = trapFetch(
    async () => new Response(htmlPage, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  );
  const trap = trapIO();
  try {
    // 404 on a DELETE is the documented "not found / already destroyed"
    // path (exit 2). That branch produces a clean message that doesn't
    // surface the body — so this guard is really about the
    // !res.ok fallthrough. We use 500 here to exercise the generic
    // formatter instead.
    fetchTrap.restore();
    const fetchTrap2 = trapFetch(
      async () => new Response(htmlPage, {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    );
    try {
      await assert.rejects(
        runDestroy([AGENT_UUID, '--cloud-url', CLOUD]),
        /__exit_trap__:1/
      );
      assert.deepEqual(trap.exits, [1]);
      assert.match(trap.stderr, /500/);
      assert.match(trap.stderr, /HTML|wrong API root/);
      // The raw <script> tags must not appear in stderr.
      assert.equal(trap.stderr.includes('<script'), false);
      assert.equal(trap.stderr.includes('<!DOCTYPE'), false);
    } finally {
      fetchTrap2.restore();
    }
  } finally {
    trap.restore();
    restoreEnv();
  }
});

test('runDestroy: reads active.json cloudUrl when no flag and no env is set', async () => {
  // The destroy command must consult `~/.agentworkforce/active.json` for
  // the cloud URL just like the deploy orchestrator does. Without this,
  // a user who ran `agentworkforce login` (which writes active.json with
  // the canonical cloud URL) would still hit the legacy default.
  const restoreIsolate = isolateAuthFiles();
  const prevToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  const prevWs = process.env.WORKFORCE_WORKSPACE_ID;
  const prevCloudA = process.env.WORKFORCE_DEPLOY_CLOUD_URL;
  const prevCloudB = process.env.WORKFORCE_CLOUD_URL;
  process.env.WORKFORCE_WORKSPACE_TOKEN = 'tok-active';
  process.env.WORKFORCE_WORKSPACE_ID = WORKSPACE;
  delete process.env.WORKFORCE_DEPLOY_CLOUD_URL;
  delete process.env.WORKFORCE_CLOUD_URL;

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'aw-destroy-active-'));
  const activeFile = path.join(tmp, 'active.json');
  await writeFile(
    activeFile,
    JSON.stringify({
      workspace: WORKSPACE,
      workspaceId: WORKSPACE,
      cloudUrl: 'https://active.example.test/cloud',
      setAt: new Date().toISOString()
    }),
    'utf8'
  );
  process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = activeFile;

  const fetchTrap = trapFetch(
    async () =>
      new Response(
        JSON.stringify({
          agentId: AGENT_UUID,
          status: 'destroyed',
          destroyedAt: '2026-05-13T00:00:00.000Z',
          cancelledScheduleIds: []
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
  const trap = trapIO();
  try {
    // No `--cloud-url` flag. The command must derive the URL from active.json.
    await assert.rejects(runDestroy([AGENT_UUID]), /__exit_trap__:0/);
    assert.equal(fetchTrap.calls.length, 1);
    assert.equal(
      fetchTrap.calls[0].url,
      `https://active.example.test/cloud/api/v1/workspaces/${WORKSPACE}/deployments/${AGENT_UUID}`
    );
  } finally {
    trap.restore();
    fetchTrap.restore();
    if (prevToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    else process.env.WORKFORCE_WORKSPACE_TOKEN = prevToken;
    if (prevWs === undefined) delete process.env.WORKFORCE_WORKSPACE_ID;
    else process.env.WORKFORCE_WORKSPACE_ID = prevWs;
    if (prevCloudA !== undefined) process.env.WORKFORCE_DEPLOY_CLOUD_URL = prevCloudA;
    if (prevCloudB !== undefined) process.env.WORKFORCE_CLOUD_URL = prevCloudB;
    restoreIsolate();
    await rm(tmp, { recursive: true, force: true });
  }
});
