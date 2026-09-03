import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBufferedIO, type BufferedIO } from '@agentworkforce/deploy';
import {
  configureEnvCommandForTest,
  parseWorkspaceEnvArgs,
  readWorkspaceEnvValue,
  runEnv
} from './env-command.js';

const CLOUD = 'https://cloud.example.test';
const SECRET = 'rth_live_SENTINEL-do-not-print-51N7INEL';

type FetchCall = { url: string; init?: RequestInit };

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function installDeps(input: {
  workspace?: string;
  cloudWorkspaceId?: string;
  stdin?: Readable;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
}): { io: BufferedIO; restore: () => void } {
  const io = createBufferedIO();
  const restore = configureEnvCommandForTest({
    createTerminalIO: () => io,
    resolveCloudUrl: () => CLOUD,
    resolveWorkspaceToken: async ({ workspace }) => ({
      token: 'workspace-bearer',
      ...(input.workspace ?? workspace ? { workspace: input.workspace ?? workspace } : {}),
      ...(input.cloudWorkspaceId
        ? { workspaceDescriptor: { cloudWorkspaceId: input.cloudWorkspaceId } as never }
        : {})
    }),
    stdin: input.stdin ?? Readable.from([]),
    fetchImpl: input.fetchImpl as typeof fetch,
    now: () => '2026-09-03T12:00:00.000Z'
  });
  return { io, restore };
}

test('env set accepts a key only and never echoes a positional secret', () => {
  assert.throws(
    () => parseWorkspaceEnvArgs(['set', 'RTH_TOKEN', SECRET]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /pass the value on stdin/);
      assert.doesNotMatch(message, new RegExp(SECRET));
      return true;
    }
  );
  assert.throws(
    () => parseWorkspaceEnvArgs(['set', 'RTH_TOKEN', `--value=${SECRET}`]),
    (error: unknown) => {
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(SECRET));
      return true;
    }
  );
});

test('env keys use a strict portable environment-variable shape', () => {
  assert.equal(parseWorkspaceEnvArgs(['set', 'RTH_TOKEN']).key, 'RTH_TOKEN');
  for (const key of ['9TOKEN', 'BAD-KEY', 'BAD.KEY', '', 'A'.repeat(129)]) {
    assert.throws(() => parseWorkspaceEnvArgs(['set', key]), /environment variable KEY|missing KEY/);
  }
});

test('stdin value reader strips one pipe newline and rejects unsafe input', async () => {
  assert.equal(await readWorkspaceEnvValue(Readable.from([`${SECRET}\r\n`])), SECRET);
  await assert.rejects(readWorkspaceEnvValue(Readable.from([])), /stdin is empty/);
  await assert.rejects(readWorkspaceEnvValue(Readable.from(['has\0nul'])), /NUL byte/);
  await assert.rejects(
    readWorkspaceEnvValue(Readable.from(['x'.repeat(64 * 1024 + 1)])),
    /exceeds 65536 bytes/
  );
  const tty = Readable.from([SECRET]) as Readable & { isTTY?: boolean };
  tty.isTTY = true;
  await assert.rejects(readWorkspaceEnvValue(tty), /non-interactive stdin/);
});

test('env set sends the secret only in the request body and reports creation without exposing it', async () => {
  const calls: FetchCall[] = [];
  const { io, restore } = installDeps({
    workspace: 'ws alpha',
    stdin: Readable.from([SECRET]),
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (init?.method === 'GET') return response({ error: 'not found' }, 404);
      return response({
        name: 'RTH_TOKEN',
        envVar: 'RTH_TOKEN',
        kind: 'environment',
        maskedValue: SECRET,
        updatedAt: '2026-09-03T11:59:00.000Z',
        setBy: 'user-1'
      }, 201);
    }
  });
  try {
    await runEnv(['set', 'RTH_TOKEN']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, `${CLOUD}/api/v1/workspaces/ws%20alpha/secrets/RTH_TOKEN`);
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(calls[1]?.url, `${CLOUD}/api/v1/workspaces/ws%20alpha/secrets`);
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      name: 'RTH_TOKEN',
      envVar: 'RTH_TOKEN',
      kind: 'environment',
      value: SECRET
    });
    const output = io.messages.map((item) => item.message).join('\n');
    assert.match(output, /Set RTH_TOKEN in workspace ws alpha/);
    assert.doesNotMatch(output, new RegExp(SECRET));
  } finally {
    restore();
  }
});

test('env set reports overwrite and JSON output contains metadata only', async () => {
  const { io, restore } = installDeps({
    workspace: 'ws-a',
    stdin: Readable.from([SECRET]),
    async fetchImpl(_url, init) {
      if (init?.method === 'GET') return response({ name: 'RTH_TOKEN' });
      return response({
        name: 'RTH_TOKEN',
        envVar: 'RTH_TOKEN',
        kind: 'environment',
        maskedValue: SECRET,
        updatedAt: '2026-09-03T11:59:00.000Z',
        setBy: 'user-2'
      });
    }
  });
  try {
    await runEnv(['set', 'RTH_TOKEN', '--json']);
    const output = io.messages.map((item) => item.message).join('\n');
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      workspace: 'ws-a',
      key: 'RTH_TOKEN',
      updatedAt: '2026-09-03T11:59:00.000Z',
      setBy: 'user-2',
      overwritten: true
    });
    assert.doesNotMatch(output, new RegExp(SECRET));
  } finally {
    restore();
  }
});

test('env list emits names and audit metadata but never values or masks', async () => {
  const { io, restore } = installDeps({
    workspace: 'ws-a',
    async fetchImpl() {
      return response({
        ok: true,
        data: {
          items: [
            {
              name: 'RTH_TOKEN',
              envVar: 'RTH_TOKEN',
              kind: 'environment',
              value: SECRET,
              maskedValue: 'rt********************************EL',
              updatedAt: '2026-09-03T11:59:00.000Z',
              setBy: 'user-1'
            },
            {
              name: 'openai-production',
              envVar: 'OPENAI_API_KEY',
              maskedValue: 'sk**********42',
              updatedAt: '2026-09-02T10:00:00.000Z'
            },
            {
              name: 'LEGACY_TOKEN',
              envVar: 'LEGACY_TOKEN',
              value: SECRET,
              updatedAt: '2026-09-01T09:00:00.000Z'
            }
          ]
        }
      });
    }
  });
  try {
    await runEnv(['list', '--json']);
    const output = io.messages.map((item) => item.message).join('\n');
    assert.deepEqual(JSON.parse(output), {
      workspace: 'ws-a',
      variables: [
        {
          key: 'RTH_TOKEN',
          updatedAt: '2026-09-03T11:59:00.000Z',
          setBy: 'user-1'
        }
      ]
    });
    assert.doesNotMatch(output, new RegExp(SECRET));
    assert.doesNotMatch(output, /rt\*+EL|sk\*+42|maskedValue|value/);
  } finally {
    restore();
  }
});

test('workspace override scopes every request and cannot cross-read another workspace', async () => {
  const calls: string[] = [];
  const { restore } = installDeps({
    async fetchImpl(url) {
      calls.push(url);
      return response({ ok: true, data: { items: [] } });
    }
  });
  try {
    await runEnv(['list', '--workspace', 'workspace-a']);
    await runEnv(['list', '--workspace', 'workspace-b']);
    assert.deepEqual(calls, [
      `${CLOUD}/api/v1/workspaces/workspace-a/secrets`,
      `${CLOUD}/api/v1/workspaces/workspace-b/secrets`
    ]);
  } finally {
    restore();
  }
});

test('cloud workspace identity wins over a relaycast provider id for storage scope', async () => {
  const calls: string[] = [];
  const { restore } = installDeps({
    workspace: '987654321',
    cloudWorkspaceId: '11111111-1111-4111-8111-111111111111',
    async fetchImpl(url) {
      calls.push(url);
      return response({ ok: true, data: { items: [] } });
    }
  });
  try {
    await runEnv(['list']);
    assert.deepEqual(calls, [
      `${CLOUD}/api/v1/workspaces/11111111-1111-4111-8111-111111111111/secrets`
    ]);
  } finally {
    restore();
  }
});

test('ambiguous workspace fails before any environment request', async () => {
  let fetched = false;
  const { restore } = installDeps({
    async fetchImpl() {
      fetched = true;
      return response({ ok: true, data: { items: [] } });
    }
  });
  try {
    await assert.rejects(runEnv(['list']), /workspace is ambiguous/);
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test('env unset refuses to report success for a missing key', async () => {
  const { io, restore } = installDeps({
    workspace: 'ws-a',
    async fetchImpl() {
      return response({ error: 'not found' }, 404);
    }
  });
  try {
    await assert.rejects(runEnv(['unset', 'RTH_TOKEN']), /RTH_TOKEN is not set/);
    assert.equal(io.messages.length, 0);
  } finally {
    restore();
  }
});

test('env unset cannot delete a same-named non-environment secret', async () => {
  const methods: Array<string | undefined> = [];
  const { io, restore } = installDeps({
    workspace: 'ws-a',
    async fetchImpl(_url, init) {
      methods.push(init?.method);
      return response({
        name: 'RTH_TOKEN',
        envVar: 'RTH_TOKEN',
        maskedValue: 'rt********EL',
        updatedAt: '2026-09-03T11:59:00.000Z'
      });
    }
  });
  try {
    await assert.rejects(runEnv(['unset', 'RTH_TOKEN']), /RTH_TOKEN is not set/);
    assert.deepEqual(methods, ['GET']);
    assert.equal(io.messages.length, 0);
  } finally {
    restore();
  }
});

test('cloud error bodies are never reflected into an env error', async () => {
  const { restore } = installDeps({
    workspace: 'ws-a',
    stdin: Readable.from([SECRET]),
    async fetchImpl(_url, init) {
      if (init?.method === 'GET') return response({ error: 'not found' }, 404);
      return response({ error: `upstream rejected ${SECRET}` }, 500);
    }
  });
  try {
    await assert.rejects(runEnv(['set', 'RTH_TOKEN']), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /HTTP 500/);
      assert.doesNotMatch(message, new RegExp(SECRET));
      return true;
    });
  } finally {
    restore();
  }
});

test('top-level CLI dispatch reaches the workspace env command', async () => {
  let fetched = false;
  const { restore } = installDeps({
    workspace: 'ws-dispatch',
    async fetchImpl() {
      fetched = true;
      return response({ ok: true, data: { items: [] } });
    }
  });
  const previousArgv = process.argv;
  process.argv = [process.execPath, 'agentworkforce', 'env', 'list'];
  try {
    const { main } = await import('./cli-impl.js');
    await main();
    assert.equal(fetched, true);
  } finally {
    process.argv = previousArgv;
    restore();
  }
});
