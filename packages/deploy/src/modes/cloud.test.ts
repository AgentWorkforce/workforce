import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createBufferedIO } from '../io.js';
import type { BundleResult, ModeLaunchInput } from '../types.js';
import {
  cloudLauncher,
  configureCloudCredentialDepsForTest,
  type CloudRunHandle
} from './cloud.js';

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

function persona(overrides: Record<string, unknown> = {}): PersonaSpec {
  return {
    id: 'demo',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'test persona',
    harness: 'codex',
    model: 'openai-codex/test',
    systemPrompt: 'help',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    schedules: [{ name: 'daily', cron: '0 9 * * *' }],
    onEvent: './agent.ts',
    ...overrides
  } as unknown as PersonaSpec;
}

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
      if (url.endsWith('/agents?persona_slug=demo')) {
        return okJson({ agents: [] });
      }
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-test/deployments');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal((body.persona as { id: string }).id, 'demo');
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

test('cloud URL precedence is flag env, cloud env, persona deployUrl, then default', async () => {
  async function deployedUrl(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, spec = persona()) {
    const { calls } = await launch({
      env,
      persona: spec,
      fetch(url) {
        if (url.includes('/agents?persona_slug=')) return okJson({ agents: [] });
        return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
      }
    });
    return calls.find((call) => call.url.endsWith('/deployments'))?.url;
  }

  const personaWithUrl = persona({ cloud: { deployUrl: 'https://persona.example.test/' } as unknown });
  assert.equal(
    await deployedUrl({
      WORKFORCE_DEPLOY_CLOUD_URL: 'https://flag.example.test/',
      WORKFORCE_CLOUD_URL: 'https://env.example.test/'
    }, personaWithUrl),
    'https://flag.example.test/api/v1/workspaces/ws-test/deployments'
  );
  assert.equal(
    await deployedUrl({ WORKFORCE_CLOUD_URL: 'https://env.example.test/' }, personaWithUrl),
    'https://env.example.test/api/v1/workspaces/ws-test/deployments'
  );
  assert.equal(
    await deployedUrl({}, personaWithUrl),
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
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
      if (url.endsWith('/deployments')) {
        return okJson({ agentId: 'agent-byok', deploymentId: 'dep-byok', status: 'active' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });
});

test('cloud harness OAuth uses provider_credentials readiness and honors no-prompt failure', async () => {
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
          assert.equal(pathname, '/api/v1/users/me/provider_credentials?model_provider=openai');
          assert.equal(init?.method, 'GET');
          return okJson({});
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
      fetch(url) {
        throw new Error(`unexpected URL ${url}`);
      }
    }),
    /OAuth credentials are not connected/
  ).finally(restoreDeps);
});

test('cloud harness OAuth starts auth and polls until provider credentials are connected', async () => {
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
          if (pathname.endsWith('/provider_credentials?model_provider=openai')) {
            credentialChecks += 1;
            assert.equal(init?.method, 'GET');
            return okJson(credentialChecks < 3 ? {} : { id: 'cred-oauth', status: 'connected' });
          }
          throw new Error(`unexpected path ${pathname}`);
        }
      };
    }
  });
  const io = createBufferedIO();
  io.scriptConfirmations([true]);
  const { bundle, cleanup } = await withBundle();
  const fetchMock = installFetch((url) => {
    if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
      fetch(url) {
        if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
    fetch(url) {
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
      deployAttempts += 1;
      if (deployAttempts < 3) {
        throw new Error('temporary network failure');
      }
      return okJson({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'active' }, 201);
    }
  });

  assert.equal(handle.id, 'agent-1');
  assert.equal(callsForUrl(calls, '/deployments'), 3);
});

test('cloud polling resolves done with code 0 on active and 1 on failed', async () => {
  for (const finalStatus of ['active', 'failed'] as const) {
    const { bundle, cleanup } = await withBundle();
    const io = createBufferedIO();
    const fetchMock = installFetch((url) => {
        if (url.includes('/provider-credentials/managed')) return okJson({ providerCredentialId: 'cred-1' });
        if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
  const fetchMock = installFetch((url) => {
    if (url.includes('/provider-credentials/managed')) return okJson({ providerCredentialId: 'cred-1' });
    if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [] });
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
      persona: persona({ integrations: { github: { triggers: [{ on: 'pull_request.opened' }] } } }),
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
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agents: [{ id: 'agent-old' }] });
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
    fetch(url) {
      if (url.endsWith('/agents?persona_slug=demo')) return okJson({ agent: { id: 'agent-old' } });
      throw new Error(`unexpected URL ${url}`);
    }
  });
  assert.equal(cancel.handle.id, 'agent-old');
  assert.equal(cancel.handle.status, 'cancelled');
  assert.equal((await cancel.handle.done).code, 0);
  assert.equal(cancel.calls.some((call) => call.url.endsWith('/deployments')), false);
});

function callsForUrl(calls: FetchCall[], suffix: string): number {
  return calls.filter((call) => call.url.endsWith(suffix)).length;
}
