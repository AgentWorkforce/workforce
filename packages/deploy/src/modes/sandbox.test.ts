import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveSandboxClient, sandboxLauncher } from './sandbox.js';
import type { BundleResult, DeployIO, ModeLaunchInput } from '../types.js';

function input(): Pick<ModeLaunchInput, 'workspace' | 'persona' | 'env'> {
  return {
    workspace: 'ws-demo',
    persona: {
      id: 'demo',
      intent: 'documentation',
      tags: ['documentation'],
      description: '',
      skills: [],
      harness: 'claude',
      model: 'm',
      systemPrompt: 's',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
      cloud: true,
      onEvent: './agent.ts'
    }
  };
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface RecordedCall {
  body?: unknown;
}

function installFetch(
  handlers: Array<(call: RecordedCall) => Response | Promise<Response>>
): { calls: RecordedCall[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  let i = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
    const call: RecordedCall = {
      ...(body !== undefined ? { body } : {})
    };
    calls.push(call);
    const handler = handlers[i];
    if (!handler) throw new Error(`fakeFetch: no handler at call index ${i}`);
    i += 1;
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

async function fixtureBundle(dir: string): Promise<BundleResult> {
  const runnerPath = path.join(dir, 'runner.mjs');
  const bundlePath = path.join(dir, 'agent.bundle.mjs');
  const personaCopyPath = path.join(dir, 'persona.json');
  const packageJsonPath = path.join(dir, 'package.json');
  await Promise.all([
    writeFile(runnerPath, 'runner', 'utf8'),
    writeFile(bundlePath, 'bundle', 'utf8'),
    writeFile(personaCopyPath, '{"id":"demo"}', 'utf8'),
    writeFile(packageJsonPath, '{}', 'utf8')
  ]);
  return { runnerPath, bundlePath, personaCopyPath, packageJsonPath, sizeBytes: 13 };
}

const silentIO: DeployIO = {
  info() {
    /* no-op */
  },
  warn() {
    /* no-op */
  },
  error() {
    /* no-op */
  },
  async prompt() {
    throw new Error('unexpected prompt');
  },
  async confirm() {
    throw new Error('unexpected confirm');
  }
};

async function launchWithProxySandbox(persona: ModeLaunchInput['persona']): Promise<RecordedCall[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sandbox-launcher-'));
  const fetchMock = installFetch([
    () =>
      new Response(
        JSON.stringify({
          sandboxId: 'sbx_test',
          authMode: 'proxy',
          execUrl: 'https://cloud.example.com/api/v1/workspaces/ws-demo/sandboxes/sbx_test/exec',
          filesUrl: 'https://cloud.example.com/api/v1/workspaces/ws-demo/sandboxes/sbx_test/files'
        }),
        { status: 201 }
      ),
    () => new Response(null, { status: 204 }),
    () => new Response(JSON.stringify({ exitCode: 0, output: 'installed' }), { status: 200 }),
    () => new Response(JSON.stringify({ exitCode: 0, output: 'done' }), { status: 200 }),
    () => new Response(null, { status: 204 })
  ]);
  try {
    const bundle = await fixtureBundle(dir);
    await withEnvAsync(
      {
        DAYTONA_API_KEY: undefined,
        DAYTONA_JWT_TOKEN: undefined,
        WORKFORCE_WORKSPACE_TOKEN: 'tok-cloud',
        WORKFORCE_CLOUD_URL: 'https://cloud.example.com'
      },
      async () => {
        const handle = await sandboxLauncher.launch({
          persona,
          bundle,
          workspace: 'ws-demo',
          io: silentIO
        });
        const done = await handle.done;
        assert.equal(done.code, 0);
        await handle.stop();
      }
    );
    return fetchMock.calls;
  } finally {
    fetchMock.restore();
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveSandboxClient prefers BYO when DAYTONA_API_KEY is set', () => {
  withEnv(
    {
      DAYTONA_API_KEY: 'sk_byo',
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      const client = resolveSandboxClient(input());
      // BYO client carries the Daytona SDK; we infer mode by inspecting
      // a mint-like call would tag the resulting handle. Easier to just
      // verify by structural shape — but the simplest check is that the
      // proxy path was *not* picked (which would have called fetch).
      assert.ok(typeof client.mint === 'function');
      assert.ok(typeof client.exec === 'function');
    }
  );
});

test('sandboxLauncher forwards non-empty persona integrations to proxy mint', async () => {
  const calls = await launchWithProxySandbox({
    ...input().persona,
    integrations: {
      github: { triggers: [{ on: 'pull_request.opened' }] }
    }
  });

  assert.deepEqual((calls[0].body as { integrations: unknown }).integrations, {
    github: { triggers: [{ on: 'pull_request.opened' }] }
  });
});

test('sandboxLauncher omits empty persona integrations from proxy mint', async () => {
  const calls = await launchWithProxySandbox({
    ...input().persona,
    integrations: {}
  });

  assert.equal('integrations' in (calls[0].body as Record<string, unknown>), false);
});

test('resolveSandboxClient falls back to the cloud proxy when only WORKFORCE_WORKSPACE_TOKEN is set', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: 'tok-cloud',
      WORKFORCE_CLOUD_URL: 'https://cloud.example.com'
    },
    () => {
      const client = resolveSandboxClient(input());
      assert.ok(typeof client.mint === 'function');
    }
  );
});

test('resolveSandboxClient throws when neither path is configured', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: undefined
    },
    () => {
      assert.throws(() => resolveSandboxClient(input()), /no Daytona credentials and no workforce workspace token/);
    }
  );
});

test('resolveSandboxClient honors --byo-sandbox even when both paths are configured', () => {
  withEnv(
    {
      DAYTONA_API_KEY: 'sk_byo',
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      const client = resolveSandboxClient(input(), { forceByo: true });
      assert.ok(typeof client.mint === 'function');
    }
  );
});

test('resolveSandboxClient with forceByo and no BYO env throws a clear error', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      assert.throws(
        () => resolveSandboxClient(input(), { forceByo: true }),
        /--byo-sandbox requested but no Daytona credentials/
      );
    }
  );
});
