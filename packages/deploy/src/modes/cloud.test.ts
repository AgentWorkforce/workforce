import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PersonaSpec, WatchRule } from '@agentworkforce/persona-kit';
import { createBufferedIO } from '../io.js';
import type { BundleResult, ModeLaunchInput } from '../types.js';
import {
  cloudLauncher,
  configureCloudCredentialDepsForTest,
  type CloudRunHandle
} from './cloud/index.js';

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

const ENV_KEYS = [
  'WORKFORCE_WORKSPACE_TOKEN',
  'WORKFORCE_DEPLOY_CLOUD_URL',
  'WORKFORCE_CLOUD_URL',
  'WORKFORCE_DEPLOY_HARNESS_SOURCE',
  'WORKFORCE_DEPLOY_BYOK_KEY',
  'WORKFORCE_DEPLOY_ON_EXISTS',
  'WORKFORCE_DEPLOY_NO_PROMPT',
  'WORKFORCE_DEPLOY_INPUTS_JSON',
  'WORKFORCE_DEPLOY_POLL_INTERVAL_MS',
  'WORKFORCE_DEPLOY_POLL_TIMEOUT_MS',
  'WORKFORCE_DEPLOY_RETRY_BACKOFF_MS'
] as const;

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'demo',
    intent: 'documentation',
    tags: ['documentation'] as const,
    description: 'test persona',
    skills: [],
    harness: 'codex',
    model: 'openai-codex/test',
    systemPrompt: 'help',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    onEvent: './agent.ts',
    ...overrides
  };
}

const agentSpec: import('@agentworkforce/persona-kit').AgentSpec = {
  schedules: [{ name: 'daily', cron: '0 9 * * *' }]
};

async function withBundle(): Promise<{ bundle: BundleResult; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-cloud-test-'));
  const runnerPath = path.join(dir, 'runner.mjs');
  const bundlePath = path.join(dir, 'agent.bundle.mjs');
  const personaCopyPath = path.join(dir, 'persona.json');
  const packageJsonPath = path.join(dir, 'package.json');
  await Promise.all([
    writeFile(runnerPath, 'export {};', 'utf8'),
    writeFile(bundlePath, 'export default {};', 'utf8'),
    writeFile(personaCopyPath, '{}', 'utf8'),
    writeFile(packageJsonPath, '{"type":"module"}', 'utf8')
  ]);
  return {
    bundle: {
      runnerPath,
      bundlePath,
      personaCopyPath,
      packageJsonPath,
      sizeBytes: 2
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function installFetch(
  handler: (url: string, init: RequestInit | undefined, calls: FetchCall[]) => Response | Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return await handler(url, init, calls);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    }
  };
}

async function withEnv<T>(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function launch(overrides: {
  persona?: PersonaSpec;
  env?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  input?: Partial<ModeLaunchInput>;
  defaultPlanCredential?: boolean;
  fetch: (url: string, init: RequestInit | undefined, calls: FetchCall[]) => Response | Promise<Response>;
}) {
  const { bundle, cleanup } = await withBundle();
  const io = createBufferedIO();
  const fetchMock = installFetch((url, init, calls) => {
    if (overrides.defaultPlanCredential !== false && url.includes('/provider-credentials/managed')) {
      assert.equal(init?.method, 'POST');
      return okJson({ providerCredentialId: 'cred-1' });
    }
    return overrides.fetch(url, init, calls);
  });
  try {
    const handle = await withEnv({
      WORKFORCE_WORKSPACE_TOKEN: 'tok',
      WORKFORCE_DEPLOY_HARNESS_SOURCE: 'plan',
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '0',
      WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '50',
      WORKFORCE_DEPLOY_RETRY_BACKOFF_MS: '0',
      ...overrides.env
    }, () => cloudLauncher.launch({
      persona: overrides.persona ?? persona(),
      agent: agentSpec,
      bundle,
      workspace: 'ws-test',
      io,
      ...overrides.input
    })) as CloudRunHandle;
    return { handle, calls: fetchMock.calls, io };
  } finally {
    fetchMock.restore();
    await cleanup();
  }
}

test('cloud launcher POSTs a deploy bundle and returns the cloud handle', async () => {
  const { handle, calls } = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    input: { inputs: { topic: 'AI' } },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({ agents: [] });
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/deployments');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal((body.persona as { id: string }).id, 'demo');
      // Listeners travel as the top-level `agent` block, not on the persona.
      assert.deepEqual(body.agent, agentSpec);
      assert.equal((body.persona as { schedules?: unknown }).schedules, undefined);
      assert.deepEqual(body.inputs, { topic: 'AI' });
      assert.deepEqual((body.bundle as { packageJson: unknown }).packageJson, { type: 'module' });
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  assert.equal(handle.deploymentId, 'dep-1');
  assert.equal((await handle.done).code, 0);
  assert.equal(calls.filter((call) => call.url.includes('/provider-credentials/managed')).length, 1);
});

test('cloud launcher sends proactive agent watch rules through the deployments endpoint', async () => {
  // Consolidation: proactive agents now flow through the same /deployments
  // POST as regular agents. Listener declarations, including watch[], travel
  // inside the top-level agent block; the persona stays connection/runtime
  // config only. No separate /proactive-personas surface.
  const watch: WatchRule[] = [{ paths: ['/i/x/**'], events: ['created'], debounceMs: 1000 }];
  const proactivePersona = persona({
    mount: { enabled: false }
  });

  const { handle, calls } = await launch({
    persona: proactivePersona,
    input: { agent: { watch } },
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({ agents: [] });
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/deployments');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal((body.persona as Record<string, unknown>).watch, undefined);
      assert.deepEqual((body.agent as Record<string, unknown>).watch, watch);
      assert.equal(body.watch, undefined);
      assert.equal(body.mount, undefined);
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'ready' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  assert.equal(handle.agentId, 'agent-1');
  assert.equal(handle.deploymentId, 'dep-1');
  assert.equal(handle.status, 'ready');
  assert.equal((await handle.done).code, 0);
  assert.equal(callsForUrl(calls, '/proactive-personas'), 0);
});

test('cloud launcher keeps non-proactive personas on the deployments endpoint', async () => {
  const { handle, calls } = await launch({
    persona: persona(),
    input: { agent: {} },
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({ agents: [] });
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/deployments');
      assert.equal(init?.method, 'POST');
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  assert.equal(callsForUrl(calls, '/deployments'), 2);
  assert.equal(callsForUrl(calls, '/proactive-personas'), 0);
});

test('cloud launcher maps proactive failed deployment responses to a failed handle', async () => {
  const watch: WatchRule[] = [{ paths: ['/i/x/**'], events: ['updated'], debounceMs: 1000 }];

  const { handle } = await launch({
    persona: persona(),
    input: { agent: { watch } },
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({ agents: [] });
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/deployments');
      assert.equal(init?.method, 'POST');
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'failed' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  assert.equal(handle.deploymentId, 'dep-1');
  assert.equal(handle.status, 'failed');
  assert.equal((await handle.done).code, 1);
});

test('cloud URL precedence is flag env, cloud env, persona deployUrl, then default', async () => {
  async function deployedUrl(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, spec = persona()) {
    const { calls } = await launch({
      env,
      persona: spec,
      fetch(url, init) {
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
      }
    });
    return calls.find((call) => call.init?.method === 'POST' && call.url.endsWith('/deployments'))?.url;
  }

  const personaWithUrl = persona() as unknown as Omit<PersonaSpec, 'cloud'> & { cloud: { deployUrl: string } };
  personaWithUrl.cloud = { deployUrl: 'https://persona.example.test/' };
  assert.equal(
    await deployedUrl({
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://flag.example.test/',
      WORKFORCE_CLOUD_URL: 'https://env.example.test/'
    }, personaWithUrl as unknown as PersonaSpec),
    'https://flag.example.test/api/v1/workspaces/ws-test/deployments'
  );
  assert.equal(
    await deployedUrl({ WORKFORCE_CLOUD_URL: 'https://env.example.test/' }, personaWithUrl as unknown as PersonaSpec),
    'https://env.example.test/api/v1/workspaces/ws-test/deployments'
  );
  assert.equal(
    await deployedUrl({}, personaWithUrl as unknown as PersonaSpec),
    'https://persona.example.test/api/v1/workspaces/ws-test/deployments'
  );
  assert.equal(
    await deployedUrl({}),
    'https://agentrelay.com/cloud/api/v1/workspaces/ws-test/deployments'
  );
});

test('cloud harness plan and BYOK save provider credentials through the cloud contract', async () => {
  const plan = await launch({
    defaultPlanCredential: false,
    env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test' },
    input: { harnessSource: 'plan' },
    fetch(url, init) {
      if (url.endsWith('/provider-credentials/managed?provider=openai')) {
        assert.equal(init?.method, 'POST');
        assert.equal(init?.body, undefined);
        return okJson({ providerCredentialId: 'cred-plan' });
      }
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-plan', deploymentId: 'dep-plan', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(plan.handle.id, 'agent-plan');

  const byok = await launch({
    defaultPlanCredential: false,
    env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test' },
    input: { harnessSource: 'byok', byokKey: 'sk-test' },
    fetch(url, init) {
      if (url.endsWith('/provider-credentials/byok')) {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          modelProvider: 'openai',
          model_provider: 'openai',
          key: 'sk-test',
          api_key: 'sk-test'
        });
        return okJson({ providerCredentialId: 'cred-byok' });
      }
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-byok', deploymentId: 'dep-byok', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(byok.handle.id, 'agent-byok');
});

test('cloud BYOK provider detection avoids substring false positives', async () => {
  await launch({
    defaultPlanCredential: false,
    persona: persona({ model: 'my-openai-alternative' }),
    env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test' },
    input: { harnessSource: 'byok', byokKey: 'sk-test' },
    fetch(url, init) {
      if (url.endsWith('/provider-credentials/byok')) {
        assert.equal(JSON.parse(String(init?.body)).modelProvider, 'my-openai-alternative');
        return okJson({ providerCredentialId: 'cred-byok' });
      }
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-byok', deploymentId: 'dep-byok', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
});

test('cloud harness OAuth probe hits /api/v1/cloud-agents and honors no-prompt failure', async () => {
  // Cloud surfaces "is the harness connected?" via the cloud-agents list,
  // not the (never-built) /users/me/provider_credentials route. When the
  // list is empty for the persona's provider, --no-prompt must surface a
  // clear actionable error rather than reaching the prompt path.
  let probeCalls = 0;
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(pathname: string, init?: RequestInit) {
          probeCalls += 1;
          assert.equal(pathname, '/api/v1/cloud-agents');
          assert.equal(init?.method, 'GET');
          return okJson({ agents: [] });
        }
      };
    }
  });
  await assert.rejects(
    launch({
      defaultPlanCredential: false,
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
        WORKFORCE_DEPLOY_NO_PROMPT: '1'
      },
      input: { harnessSource: 'oauth' },
      fetch(url, init) {
        throw new Error(`unexpected URL ${url}`);
      }
    }),
    /OAuth credentials are not connected/
  ).finally(restoreDeps);
  assert.ok(probeCalls >= 1);
});

test('cloud harness OAuth probe treats a matching connected entry as ready (skips prompt)', async () => {
  // Regression for the user-facing M3 bug: an Anthropic-connected user
  // hit "credentials are not connected" because the probe pointed at a
  // phantom route. With the probe fixed and a connected entry present,
  // the harness check resolves silently and the deploy proceeds.
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          assert.equal(pathname, '/api/v1/cloud-agents');
          return okJson({
            agents: [
              {
                id: 'cloud-agent-1',
                harness: 'openai', // matches persona's derived provider
                status: 'connected',
                credentialStoredAt: '2026-05-13T12:00:00.000Z'
              }
            ]
          });
        }
      };
    }
  });

  const { calls, handle } = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_NO_PROMPT: '1'
    },
    input: { harnessSource: 'oauth' },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson(
          { agentId: 'agent-oauth-connected', deploymentId: 'dep-1', status: 'active' },
          201
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }
  }).finally(restoreDeps);

  assert.equal(handle.id, 'agent-oauth-connected');
  // No connect-provider call should have fired because the probe already
  // returned a connected entry.
  assert.ok(!calls.some((c) => c.url.includes('/cli/auth')));
});

test('cloud harness OAuth probe ignores entries with the wrong harness', async () => {
  // If the user has openai connected but the persona's provider is
  // anthropic, the probe must NOT treat that as readiness — otherwise
  // the deploy would proceed with cloud expecting an anthropic key it
  // never received.
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch() {
          return okJson({
            agents: [
              { harness: 'openai', status: 'connected' },
              { harness: 'anthropic', status: 'pending' }, // wrong status
              { harness: 'google', status: 'connected' }   // wrong harness
            ]
          });
        }
      };
    }
  });

  // Override the persona to claude/anthropic so the expected provider mismatches.
  await assert.rejects(
    launch({
      defaultPlanCredential: false,
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
        WORKFORCE_DEPLOY_NO_PROMPT: '1'
      },
      input: { harnessSource: 'oauth' },
      persona: persona({ harness: 'claude', model: 'claude-sonnet-4-6' }),
      fetch(url, init) {
        throw new Error(`unexpected URL ${url}`);
      }
    }),
    /OAuth credentials are not connected/
  ).finally(restoreDeps);
});

test('cloud harness OAuth starts auth and polls /cloud-agents until the harness is connected', async () => {
  let credentialChecks = 0;
  const connected: string[] = [];
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    connectProvider: async (options: { provider: string }) => {
      connected.push(options.provider);
      return { provider: options.provider, success: true };
    },
    createCloudApiClient() {
      return {
        async fetch(pathname: string, init?: RequestInit) {
          if (pathname === '/api/v1/cloud-agents') {
            credentialChecks += 1;
            assert.equal(init?.method, 'GET');
            // First two polls: harness not yet connected (empty list).
            // Third poll: openai entry appears with status connected.
            return okJson(credentialChecks < 3
              ? { agents: [] }
              : { agents: [{ id: 'cloud-agent-openai', harness: 'openai', status: 'connected' }] });
          }
          throw new Error(`unexpected path ${pathname}`);
        }
      };
    }
  });
  const io = createBufferedIO();
  io.scriptConfirmations([true]);
  const { bundle, cleanup } = await withBundle();
  const fetchMock = installFetch((url, init) => {
    if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
    if (url.endsWith('/deployments')) {
      return okJson({ agentId: 'agent-oauth', deploymentId: 'dep-oauth', status: 'active' }, 201);
    }
    throw new Error(`unexpected URL ${url}`);
  });

  try {
    const handle = await withEnv({
      WORKFORCE_WORKSPACE_TOKEN: 'tok',
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_HARNESS_SOURCE: 'oauth',
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '0',
      WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '50',
      WORKFORCE_DEPLOY_RETRY_BACKOFF_MS: '0'
    }, () => cloudLauncher.launch({
      persona: persona(),
      agent: agentSpec,
      bundle,
      workspace: 'ws-test',
      io
    }));
    assert.equal(handle.id, 'agent-oauth');
  } finally {
    fetchMock.restore();
    restoreDeps();
    await cleanup();
  }

  assert.equal(credentialChecks, 3);
  assert.deepEqual(connected, ['openai']);
});

test('cloud launcher maps 401 deploy responses to the workforce login guidance', async () => {
  await assert.rejects(
    launch({
      env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test' },
      fetch(url, init) {
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        return okJson({ error: 'Unauthorized' }, 401);
      }
    }),
    /Run `workforce login`/
  );
});

test('cloud launcher retries retryable network failures three times', async () => {
  let deployAttempts = 0;
  const { calls, handle } = await launch({
    env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test' },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      deployAttempts += 1;
      if (deployAttempts < 3) {
        throw new Error('temporary network failure');
      }
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  // 3 POST attempts (2 failed + 1 success). The listing GET is filtered
  // out so the retry count remains exact regardless of the existing-agent
  // preflight call.
  assert.equal(
    calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith('/deployments')).length,
    3
  );
});

test('cloud polling resolves done with code 0 on active and 1 on failed', async () => {
  for (const finalStatus of ['active', 'failed'] as const) {
    const { bundle, cleanup } = await withBundle();
    const io = createBufferedIO();
    const fetchMock = installFetch((url, init) => {
        if (url.includes('/provider-credentials/managed')) return okJson({ providerCredentialId: 'cred-1' });
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        if (url.endsWith('/deployments')) {
          return okJson({ agentId: `agent-${finalStatus}`, deploymentId: `dep-${finalStatus}`, status: 'starting' }, 201);
        }
        if (url.endsWith(`/agents/agent-${finalStatus}`)) {
          return okJson({ status: finalStatus });
        }
        throw new Error(`unexpected URL ${url}`);
    });
    try {
      const streamedLogs: string[] = [];
      const handle = await withEnv({
        WORKFORCE_WORKSPACE_TOKEN: 'tok',
        WORKFORCE_DEPLOY_CLOUD_URL: `https://${finalStatus}.example.test`,
        WORKFORCE_DEPLOY_HARNESS_SOURCE: 'plan',
        WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '0',
        WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '50',
        WORKFORCE_DEPLOY_RETRY_BACKOFF_MS: '0'
      }, () => cloudLauncher.launch({
        persona: persona(),
        agent: agentSpec,
        bundle,
        workspace: 'ws-test',
        io,
        onLog: (line) => streamedLogs.push(line)
      }));
      assert.equal((await handle.done).code, finalStatus === 'active' ? 0 : 1);
      assert.ok(streamedLogs.includes(`cloud: status ${finalStatus}`));
    } finally {
      fetchMock.restore();
      await cleanup();
    }
  }
});

test('cloud stop calls the destroy agent endpoint', async () => {
  const { bundle, cleanup } = await withBundle();
  const io = createBufferedIO();
  const fetchMock = installFetch((url, init) => {
      if (url.includes('/provider-credentials/managed')) return okJson({ providerCredentialId: 'cred-1' });
      if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/agents/agent-1/destroy');
      assert.equal(init?.method, 'POST');
      return okJson({ ok: true });
  });

  try {
    const handle = await withEnv({
      WORKFORCE_WORKSPACE_TOKEN: 'tok',
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_HARNESS_SOURCE: 'plan',
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '0',
      WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '50'
    }, () => cloudLauncher.launch({
      persona: persona(),
      agent: agentSpec,
      bundle,
      workspace: 'ws-test',
      io
    }));
    await handle.stop();
    assert.equal(fetchMock.calls.at(-1)?.init?.method, 'POST');
  } finally {
    fetchMock.restore();
    await cleanup();
  }
});

test('cloud launcher leaves integration preflight to the deploy orchestrator', async () => {
  const io = createBufferedIO();
  const { bundle, cleanup } = await withBundle();
  const fetchMock = installFetch((url, init) => {
    if (url.includes('/provider-credentials/managed')) return okJson({ providerCredentialId: 'cred-1' });
    if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
    if (url.endsWith('/deployments')) {
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
    }
    throw new Error(`unexpected URL ${url}`);
  });

  try {
    await withEnv({
      WORKFORCE_WORKSPACE_TOKEN: 'tok',
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_HARNESS_SOURCE: 'plan',
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '0',
      WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '50'
    }, () => cloudLauncher.launch({
      persona: persona({ integrations: { github: {} } }),
      agent: { triggers: { github: [{ on: 'pull_request.opened' }] } },
      bundle,
      workspace: 'ws-test',
      io
    }));
  } finally {
    fetchMock.restore();
    await cleanup();
  }

  assert.equal(fetchMock.calls.some((call) => call.url.includes('/integrations')), false);
});

test('cloud existing-persona stage honors destroy and cancel choices', async () => {
  const destroy = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'destroy'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        // Workspace-scoped listing must identify the persona it belongs to
        // (deployedName is what cloud derives from the slug). A row without
        // any persona-identifying field is intentionally NOT treated as a
        // match by the post-cloud#580 client-side filter.
        return okJson({
          agents: [{
            id: 'agent-old',
            deployedName: 'demo',
            status: 'active',
            createdAt: '2026-05-12T00:00:00.000Z'
          }]
        });
      }
      if (url.endsWith('/agents/agent-old/destroy')) {
        assert.equal(init?.method, 'POST');
        return okJson({ ok: true });
      }
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-new', deploymentId: 'dep-new', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(destroy.handle.id, 'agent-new');
  assert.equal(destroy.calls.some((call) => call.init?.method === 'POST' && call.url.endsWith('/destroy')), true);

  const cancel = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'cancel'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({
          agents: [{
            agentId: 'agent-old',
            deployedName: 'demo',
            status: 'active',
            createdAt: '2026-05-13T00:00:00.000Z'
          }],
          nextCursor: null
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(cancel.handle.id, 'agent-old');
  assert.equal(cancel.handle.status, 'cancelled');
  assert.equal((await cancel.handle.done).code, 0);
  // No deploy POST should fire — the listing GET is expected and not what
  // this assertion is guarding against.
  assert.equal(
    cancel.calls.some((call) => call.init?.method === 'POST' && call.url.endsWith('/deployments')),
    false
  );
});

test('findExistingAgent: parses the new /deployments shape ({agentId, personaId, status})', async () => {
  // Regression for the production blocker: cloud#580 changed the list
  // shape from {agent:{id}} → {agents:[{agentId, personaId, status}]}.
  // We must accept the new keys (agentId) and still filter out
  // destroyed tombstones + persona-id mismatches.
  const result = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'cancel'
    },
    fetch(url, init) {
      if (url.endsWith('/deployments')) {
        return okJson({
          agents: [
            // Destroyed tombstone for the same persona — must be skipped.
            {
              agentId: 'agent-destroyed',
              personaId: 'demo',
              status: 'destroyed',
              createdAt: '2026-05-12T00:00:00.000Z'
            },
            // Different persona — must be skipped even though the
            // server-side filter should already exclude it.
            {
              agentId: 'agent-wrong-persona',
              personaId: 'something-else',
              status: 'active',
              createdAt: '2026-05-13T00:00:00.000Z'
            },
            // The actual match.
            {
              agentId: 'agent-current',
              personaId: 'demo',
              status: 'active',
              createdAt: '2026-05-13T12:00:00.000Z'
            }
          ],
          nextCursor: null
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(result.handle.id, 'agent-current');
  assert.equal(result.handle.status, 'cancelled');
});

test('findExistingAgent: empty agents array means "no existing deployment"', async () => {
  const { handle, calls } = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({ agents: [], nextCursor: null });
      }
      if (init?.method === 'POST' && url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-fresh', deploymentId: 'dep-1', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url} (${init?.method})`);
    }
  });
  assert.equal(handle.id, 'agent-fresh');
  // The list lookup must have fired before the deploy POST.
  const getIndex = calls.findIndex(
    (c) => c.init?.method === 'GET' && c.url.endsWith('/deployments')
  );
  const postIndex = calls.findIndex(
    (c) => c.init?.method === 'POST' && c.url.endsWith('/deployments')
  );
  assert.notEqual(getIndex, -1);
  assert.notEqual(postIndex, -1);
  assert.ok(getIndex < postIndex, 'listing GET must precede deploy POST');
});

test('findExistingAgent: workspace-scoped list rows without persona-identifying fields are NOT matched', async () => {
  // The new /deployments endpoint is workspace-scoped, not persona-scoped.
  // A row that lacks deployedName/personaSlug/personaId could belong to
  // any persona in the workspace; client-side matching MUST refuse to
  // treat it as "the persona we're deploying". Otherwise on-exists could
  // act on the wrong agent. (Legacy `{agent:{id}}` envelope keeps its
  // back-compat because the URL path implied persona-scoping; that
  // path is exercised by the "cloud existing-persona stage" test.)
  const result = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({
          agents: [
            // Row with NO persona-identifying field — must be ignored.
            { agentId: 'agent-mystery', status: 'active' }
          ],
          nextCursor: null
        });
      }
      if (init?.method === 'POST' && url.endsWith('/deployments')) {
        // Deploy proceeds as if no existing agent was found.
        return okJson({ agentId: 'agent-fresh', deploymentId: 'dep-1', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url} (${init?.method})`);
    }
  });
  assert.equal(result.handle.id, 'agent-fresh');
});

test('findExistingAgent: multiple active rows for the same persona — newest wins', async () => {
  // During a destroy+redeploy race or a soft-delete window, the workspace
  // can briefly hold two active rows for the same persona slug. The CLI
  // should act on the newest one, not whichever cloud returns first in
  // the unordered array.
  const result = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'cancel'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({
          agents: [
            {
              agentId: 'agent-stale',
              deployedName: 'demo',
              status: 'active',
              createdAt: '2026-05-12T00:00:00.000Z'
            },
            {
              agentId: 'agent-current',
              deployedName: 'demo',
              status: 'active',
              createdAt: '2026-05-13T12:00:00.000Z'
            },
            {
              agentId: 'agent-tombstone',
              deployedName: 'demo',
              status: 'destroyed',
              createdAt: '2026-05-13T13:00:00.000Z'
            }
          ],
          nextCursor: null
        });
      }
      throw new Error(`unexpected URL ${url} (${init?.method})`);
    }
  });
  assert.equal(result.handle.id, 'agent-current', 'newest active row should win');
  assert.equal(result.handle.status, 'cancelled');
});

test('findExistingAgent: active row wins over an older active and over inactive rows', async () => {
  // Status tier (active > anything else) outranks createdAt — guards
  // against picking a newer `failed` row over an older `active` one.
  const result = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'cancel'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({
          agents: [
            {
              agentId: 'agent-active-old',
              deployedName: 'demo',
              status: 'active',
              createdAt: '2026-05-10T00:00:00.000Z'
            },
            {
              agentId: 'agent-failed-new',
              deployedName: 'demo',
              status: 'failed',
              createdAt: '2026-05-13T00:00:00.000Z'
            }
          ],
          nextCursor: null
        });
      }
      throw new Error(`unexpected URL ${url} (${init?.method})`);
    }
  });
  assert.equal(result.handle.id, 'agent-active-old');
});

test('findExistingAgent: malformed array entries (null/empty) are skipped without throwing', async () => {
  const result = await launch({
    env: {
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_DEPLOY_ON_EXISTS: 'cancel'
    },
    fetch(url, init) {
      if (init?.method === 'GET' && url.endsWith('/deployments')) {
        return okJson({
          agents: [
            null,
            undefined,
            {},
            { agentId: '' },
            {
              agentId: 'agent-valid',
              deployedName: 'demo',
              status: 'active',
              createdAt: '2026-05-13T00:00:00.000Z'
            }
          ],
          nextCursor: null
        });
      }
      throw new Error(`unexpected URL ${url} (${init?.method})`);
    }
  });
  assert.equal(result.handle.id, 'agent-valid');
});

function callsForUrl(calls: FetchCall[], suffix: string): number {
  return calls.filter((call) => call.url.endsWith(suffix)).length;
}

test('cloud oauth deploy stamps anthropic credentialSelections from the connected row', async () => {
  // workforce#196: the byok/plan legs stamp the credential they create, but
  // the oauth leg deployed with empty selections, so ctx.llm stubbed on
  // every fire. The connected row id comes back through
  // /api/v1/cloud-agents (cloud selects it straight from
  // provider_credentials). Note the row's harness field holds the
  // OAuth-completion alias 'claude', not the model-provider string
  // 'anthropic' — the lookup must match both spellings.
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          assert.equal(pathname, '/api/v1/cloud-agents');
          return okJson({
            agents: [
              { id: 'pc-anthropic-1', harness: 'claude', status: 'connected' }
            ]
          });
        }
      };
    }
  });
  try {
    const { handle, io } = await launch({
      persona: persona({ harness: 'claude', model: 'claude-sonnet-4-6' }),
      defaultPlanCredential: false,
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
        WORKFORCE_DEPLOY_HARNESS_SOURCE: 'oauth',
        WORKFORCE_DEPLOY_NO_PROMPT: '1'
      },
      fetch(url, init) {
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        if (url.endsWith('/deployments')) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.deepEqual(body.credentialSelections, { anthropic: 'pc-anthropic-1' });
          assert.deepEqual(body.credential_selections, { anthropic: 'pc-anthropic-1' });
          return okJson({ agentId: 'agent-oauth-anthropic', deploymentId: 'dep-1', status: 'active' }, 201);
        }
        throw new Error(`unexpected URL ${url}`);
      }
    });
    assert.equal(handle.id, 'agent-oauth-anthropic');
    assert.ok(
      io.messages.some((entry) => entry.message.includes('selected connected anthropic credential')),
      'expected the selected-credential info line'
    );
  } finally {
    restoreDeps();
  }
});

test('cloud oauth deploy does NOT stamp openai selections and prints the harness-only message', async () => {
  // ChatGPT/codex OAuth tokens are harness-only: cloud's runtime credential
  // resolution rejects them for env injection, so stamping one would turn
  // the ctx.llm stub into a failed delivery. The deploy must stay
  // unstamped and tell the user the working alternatives.
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          assert.equal(pathname, '/api/v1/cloud-agents');
          return okJson({
            agents: [
              { id: 'pc-openai-1', harness: 'openai', status: 'connected' }
            ]
          });
        }
      };
    }
  });
  try {
    const { io } = await launch({
      defaultPlanCredential: false,
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
        WORKFORCE_DEPLOY_HARNESS_SOURCE: 'oauth',
        WORKFORCE_DEPLOY_NO_PROMPT: '1'
      },
      fetch(url, init) {
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        if (url.endsWith('/deployments')) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.deepEqual(body.credentialSelections, {});
          assert.deepEqual(body.credential_selections, {});
          return okJson({ agentId: 'agent-oauth-openai', deploymentId: 'dep-1', status: 'active' }, 201);
        }
        throw new Error(`unexpected URL ${url}`);
      }
    });
    assert.ok(
      io.messages.some((entry) => entry.message.includes('harness-only')),
      'expected the harness-only guidance line'
    );
  } finally {
    restoreDeps();
  }
});

test('cloud oauth deploy falls back to unstamped when the connected row has no id', async () => {
  // Defensive split between the probe and the stamp: a connected entry
  // missing its id must still count as connected (no reconnect prompt)
  // while the selection stamp degrades to today's unstamped behavior with
  // an explanatory line instead of failing the deploy.
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    createCloudApiClient() {
      return {
        async fetch(pathname: string) {
          assert.equal(pathname, '/api/v1/cloud-agents');
          return okJson({
            agents: [{ harness: 'claude', status: 'connected' }]
          });
        }
      };
    }
  });
  try {
    const { handle, io } = await launch({
      persona: persona({ harness: 'claude', model: 'claude-sonnet-4-6' }),
      defaultPlanCredential: false,
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://cloud.example.test',
        WORKFORCE_DEPLOY_HARNESS_SOURCE: 'oauth',
        WORKFORCE_DEPLOY_NO_PROMPT: '1'
      },
      fetch(url, init) {
        if (init?.method === 'GET' && url.endsWith('/deployments')) return okJson({ agents: [] });
        if (url.endsWith('/deployments')) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.deepEqual(body.credentialSelections, {});
          return okJson({ agentId: 'agent-oauth-noid', deploymentId: 'dep-1', status: 'active' }, 201);
        }
        throw new Error(`unexpected URL ${url}`);
      }
    });
    assert.equal(handle.id, 'agent-oauth-noid');
    assert.ok(
      io.messages.some((entry) => entry.message.includes('no connected anthropic credential row')),
      'expected the unstamped-fallback info line'
    );
  } finally {
    restoreDeps();
  }
});
