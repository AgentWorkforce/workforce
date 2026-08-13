/**
 * Characterization tests for the cloud subscription credential flow:
 * - validateCloudSubscriptionSupport
 * - ensureCloudSubscriptionReady (byok + oauth legs)
 *
 * These freeze the deploy-time contract introduced to fix workforce#196.
 * When cloud changes the /api/v1/cloud-agents response shape, update the
 * mock shapes deliberately, not mechanically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createBufferedIO } from '../io.js';
import {
  configureCloudCredentialDepsForTest,
  validateCloudSubscriptionSupport,
  ensureCloudSubscriptionReady
} from './cloud/index.js';

// ---------------------------------------------------------------------------
// Helpers — mirror the structure of cloud.test.ts
// ---------------------------------------------------------------------------

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

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

type FetchCall = { url: string; init: RequestInit | undefined };

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
  return { calls, restore: () => { globalThis.fetch = previous; } };
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
    if (value !== undefined) process.env[key as (typeof ENV_KEYS)[number]] = value;
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

// Minimal args for ensureCloudSubscriptionReady
function subscriptionArgs(
  io: ReturnType<typeof createBufferedIO>,
  overrides: Partial<Parameters<typeof ensureCloudSubscriptionReady>[0]> = {}
): Parameters<typeof ensureCloudSubscriptionReady>[0] {
  return {
    cloudUrl: 'https://cloud.example.test',
    workspaceId: 'ws-test',
    token: 'tok',
    persona: persona(),
    io,
    noPrompt: true,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Step 2 — subscription-source tests (tests 1–3)
// ---------------------------------------------------------------------------

test('validateCloudSubscriptionSupport throws when harnessSource is managed', () => {
  assert.throws(
    () => validateCloudSubscriptionSupport({ persona: persona(), harnessSource: 'managed' }),
    (err: Error) => {
      assert.ok(
        err.message.includes('useSubscription:true'),
        `expected useSubscription message, got: ${err.message}`
      );
      assert.ok(
        err.message.includes('--harness-source oauth'),
        `expected --harness-source oauth hint, got: ${err.message}`
      );
      return true;
    }
  );
});

test('validateCloudSubscriptionSupport throws when harnessSource is legacy plan alias', () => {
  assert.throws(
    () => validateCloudSubscriptionSupport({ persona: persona(), harnessSource: 'plan' }),
    /useSubscription:true/
  );
});

test('validateCloudSubscriptionSupport throws when WORKFORCE_DEPLOY_HARNESS_SOURCE=plan', async () => {
  await withEnv({ WORKFORCE_DEPLOY_HARNESS_SOURCE: 'plan' }, async () => {
    assert.throws(
      () => validateCloudSubscriptionSupport({ persona: persona() }),
      /useSubscription:true/
    );
  });
});

test('validateCloudSubscriptionSupport throws when WORKFORCE_DEPLOY_HARNESS_SOURCE=managed', async () => {
  await withEnv({ WORKFORCE_DEPLOY_HARNESS_SOURCE: 'managed' }, async () => {
    assert.throws(
      () => validateCloudSubscriptionSupport({ persona: persona() }),
      /useSubscription:true/
    );
  });
});

test('ensureCloudSubscriptionReady oauth leg throws "credentials are not connected" under noPrompt when no connected row', async () => {
  // Default source is oauth when no harnessSource supplied. With no connected
  // entry in /cloud-agents and noPrompt:true, must throw the subscription
  // variant of the not-connected error.
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
          return okJson({ agents: [] });
        }
      };
    }
  });

  const io = createBufferedIO();
  try {
    await assert.rejects(
      withEnv({ WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1' }, () =>
        ensureCloudSubscriptionReady(subscriptionArgs(io, { noPrompt: true }))
      ),
      (err: Error) => {
        // index.ts:597–602: the useSubscription noPrompt error
        assert.ok(
          err.message.includes('useSubscription:true'),
          `expected useSubscription message, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    restoreDeps();
  }
});

// ---------------------------------------------------------------------------
// Step 3 — BYOK-leg tests (tests 4–6)
// ---------------------------------------------------------------------------

test('ensureCloudSubscriptionReady byok leg POSTs credential and returns credentialSelections', async () => {
  const restoreDeps = configureCloudCredentialDepsForTest({});

  const fetchMock = installFetch((url, init) => {
    if (url.endsWith('/provider-credentials/byok')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        modelProvider: 'openai',
        model_provider: 'openai',
        key: 'sk-sub-test',
        api_key: 'sk-sub-test'
      });
      return okJson({ providerCredentialId: 'cred-sub-byok' });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const io = createBufferedIO();
  try {
    const result = await withEnv({
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1'
    }, () =>
      ensureCloudSubscriptionReady(subscriptionArgs(io, {
        harnessSource: 'byok',
        byokKey: 'sk-sub-test',
        noPrompt: true
      }))
    );
    assert.equal(result.provider, 'openai');
    assert.deepEqual(result.credentialSelections, { openai: 'cred-sub-byok' });
  } finally {
    fetchMock.restore();
    restoreDeps();
  }
});

test('ensureCloudSubscriptionReady byok leg throws when no key and noPrompt', async () => {
  const restoreDeps = configureCloudCredentialDepsForTest({});

  const io = createBufferedIO();
  try {
    await assert.rejects(
      withEnv({ WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1' }, () =>
        ensureCloudSubscriptionReady(subscriptionArgs(io, {
          harnessSource: 'byok',
          byokKey: undefined,
          noPrompt: true
        }))
      ),
      /requires --byok-key or WORKFORCE_DEPLOY_BYOK_KEY/
    );
  } finally {
    restoreDeps();
  }
});

test('ensureCloudSubscriptionReady byok leg uses WORKFORCE_DEPLOY_BYOK_KEY without prompting', async () => {
  const restoreDeps = configureCloudCredentialDepsForTest({});

  // Install a prompt stub that fails the test if called
  const io = createBufferedIO();
  const originalPrompt = io.prompt.bind(io);
  io.prompt = async () => {
    assert.fail('io.prompt must not be called when WORKFORCE_DEPLOY_BYOK_KEY is set');
    return originalPrompt('');
  };

  const fetchMock = installFetch((url, init) => {
    if (url.endsWith('/provider-credentials/byok')) {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.key, 'sk-from-env');
      return okJson({ providerCredentialId: 'cred-env-byok' });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  try {
    const result = await withEnv({ WORKFORCE_DEPLOY_BYOK_KEY: 'sk-from-env', WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1' }, () =>
      ensureCloudSubscriptionReady(subscriptionArgs(io, {
        harnessSource: 'byok',
        byokKey: undefined,
        noPrompt: false // would prompt if key not found, but env key should take precedence
      }))
    );
    assert.equal(result.provider, 'openai');
    assert.deepEqual(result.credentialSelections, { openai: 'cred-env-byok' });
  } finally {
    fetchMock.restore();
    restoreDeps();
  }
});

// ---------------------------------------------------------------------------
// Step 4 — OAuth-leg tests (tests 7–9)
// ---------------------------------------------------------------------------

test('ensureCloudSubscriptionReady oauth leg resolves without connectProvider when already connected (anthropic persona)', async () => {
  let connectCalled = false;
  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    connectProvider: async () => {
      connectCalled = true;
      return { provider: 'anthropic', success: true };
    },
    createCloudApiClient() {
      return {
        async fetch() {
          return okJson({
            agents: [
              {
                id: 'pc-anthropic-1',
                harness: 'anthropic',
                status: 'connected',
                credentialStoredAt: '2026-05-01T00:00:00.000Z'
              }
            ]
          });
        }
      };
    }
  });

  const io = createBufferedIO();
  try {
    const result = await withEnv({ WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1' }, () =>
      ensureCloudSubscriptionReady(subscriptionArgs(io, {
        persona: persona({ harness: 'claude', model: 'claude-sonnet-4-6' }),
        harnessSource: 'oauth',
        noPrompt: true
      }))
    );
    assert.equal(result.provider, 'anthropic');
    // anthropic credentials ARE stampable for ctx.llm
    assert.ok(
      result.credentialSelections !== undefined,
      'expected credentialSelections for anthropic persona'
    );
    assert.deepEqual(result.credentialSelections, { anthropic: 'pc-anthropic-1' });
    assert.equal(connectCalled, false, 'connectProvider should not be called when already connected');
  } finally {
    restoreDeps();
  }
});

test('ensureCloudSubscriptionReady oauth leg connects, polls until connected, then returns selections', async () => {
  let connectCalled = false;
  let pollCount = 0;

  const restoreDeps = configureCloudCredentialDepsForTest({
    readStoredAuth: async () => ({
      apiUrl: 'https://cloud.example.test',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z'
    }),
    connectProvider: async (options: { provider: string }) => {
      connectCalled = true;
      assert.equal(options.provider, 'anthropic');
      return { provider: options.provider, success: true };
    },
    createCloudApiClient() {
      return {
        async fetch() {
          pollCount += 1;
          // First 2 polls: not yet connected. From the 3rd poll: connected.
          if (pollCount < 3) {
            return okJson({ agents: [] });
          }
          return okJson({
            agents: [
              {
                id: 'pc-anthropic-poll',
                harness: 'anthropic',
                status: 'connected',
                credentialStoredAt: '2026-05-01T00:00:00.000Z'
              }
            ]
          });
        }
      };
    }
  });

  const io = createBufferedIO();
  io.scriptConfirmations([true]); // confirm "Connect … now?"

  try {
    const result = await withEnv({
      WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1',
      WORKFORCE_DEPLOY_POLL_TIMEOUT_MS: '5000'
    }, () =>
      ensureCloudSubscriptionReady(subscriptionArgs(io, {
        persona: persona({ harness: 'claude', model: 'claude-sonnet-4-6' }),
        harnessSource: 'oauth',
        noPrompt: false
      }))
    );
    assert.equal(result.provider, 'anthropic');
    assert.ok(connectCalled, 'connectProvider should have been called');
    assert.ok(pollCount >= 3, `expected at least 3 polls, got ${pollCount}`);
    assert.deepEqual(result.credentialSelections, { anthropic: 'pc-anthropic-poll' });
  } finally {
    restoreDeps();
  }
});

test('ensureCloudSubscriptionReady oauth leg returns { provider } without credentialSelections for non-anthropic when no anthropic fallback', async () => {
  // openai harness: harness-only, no anthropic credential available → no selections
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
          // openai is connected for harness, but no anthropic row available
          return okJson({
            agents: [
              {
                id: 'pc-openai-1',
                harness: 'openai',
                status: 'connected',
                credentialStoredAt: '2026-05-01T00:00:00.000Z'
              }
            ]
          });
        }
      };
    }
  });

  const io = createBufferedIO();
  try {
    const result = await withEnv({ WORKFORCE_DEPLOY_POLL_INTERVAL_MS: '1' }, () =>
      ensureCloudSubscriptionReady(subscriptionArgs(io, {
        persona: persona({ harness: 'codex', model: 'openai-codex/test' }),
        harnessSource: 'oauth',
        noPrompt: true
      }))
    );
    assert.equal(result.provider, 'openai');
    // No anthropic credential → no credentialSelections key (index.ts:564–566)
    assert.equal(
      'credentialSelections' in result,
      false,
      'expected no credentialSelections key for non-anthropic with no anthropic fallback'
    );
  } finally {
    restoreDeps();
  }
});
