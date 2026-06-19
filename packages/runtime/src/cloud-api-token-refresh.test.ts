import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureFreshCloudApiToken,
  startCloudApiTokenRefresher,
  CloudApiTokenHorizonError,
  resetInFlightRefreshForTests,
  type CloudApiTokenEnv
} from './cloud-api-token-refresh.js';

/** Let queued microtasks (fetch + .json()) settle after a mocked timer fires. */
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const NOW = Date.parse('2026-06-19T00:00:00.000Z');

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(
  response: { status?: number; payload?: unknown; rawBody?: string },
  captured: CapturedRequest[] = []
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    });
    const status = response.status ?? 200;
    const body = response.rawBody ?? JSON.stringify(response.payload ?? {});
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function freshPair(suffix: string) {
  return {
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    accessTokenExpiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
}

function refreshableEnv(overrides: Partial<CloudApiTokenEnv> = {}): CloudApiTokenEnv {
  return {
    CLOUD_API_ACCESS_TOKEN: 'access-old',
    CLOUD_API_TOKEN: 'access-old',
    CLOUD_API_REFRESH_TOKEN: 'refresh-old',
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: new Date(NOW + 60 * 1000).toISOString(), // ~1min → within skew
    CLOUD_API_REFRESH_URL: 'https://api.relayauth.dev/v1/tokens/refresh',
    ...overrides
  };
}

test('returns the current token untouched when it is comfortably fresh', async () => {
  resetInFlightRefreshForTests();
  const captured: CapturedRequest[] = [];
  const env = refreshableEnv({
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: new Date(NOW + 60 * 60 * 1000).toISOString() // +1h
  });
  const token = await ensureFreshCloudApiToken(env, {
    now: NOW,
    fetchImpl: stubFetch({ payload: freshPair('new') }, captured)
  });
  assert.equal(token, 'access-old');
  assert.equal(captured.length, 0, 'no refresh call when fresh');
});

test('refreshes within the skew window and rotates-and-persists all vars', async () => {
  resetInFlightRefreshForTests();
  const captured: CapturedRequest[] = [];
  const env = refreshableEnv();
  const token = await ensureFreshCloudApiToken(env, {
    now: NOW,
    fetchImpl: stubFetch({ payload: freshPair('new') }, captured)
  });
  assert.equal(token, 'access-new');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.url, 'https://api.relayauth.dev/v1/tokens/refresh');
  assert.equal(captured[0]?.body.refreshToken, 'refresh-old');
  // both token vars carry the new access token; refresh token rotated
  assert.equal(env.CLOUD_API_ACCESS_TOKEN, 'access-new');
  assert.equal(env.CLOUD_API_TOKEN, 'access-new');
  assert.equal(env.CLOUD_API_REFRESH_TOKEN, 'refresh-new');
  assert.equal(env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT, freshPair('new').accessTokenExpiresAt);
});

test('refreshes when the access token is already expired', async () => {
  resetInFlightRefreshForTests();
  const captured: CapturedRequest[] = [];
  const env = refreshableEnv({
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: new Date(NOW - 60 * 1000).toISOString() // expired
  });
  const token = await ensureFreshCloudApiToken(env, {
    now: NOW,
    fetchImpl: stubFetch({ payload: freshPair('new') }, captured)
  });
  assert.equal(token, 'access-new');
  assert.equal(captured.length, 1);
});

test('returns the current token when no refresh material is present', async () => {
  resetInFlightRefreshForTests();
  const captured: CapturedRequest[] = [];
  const env = refreshableEnv({ CLOUD_API_REFRESH_TOKEN: '', CLOUD_API_REFRESH_URL: '' });
  const token = await ensureFreshCloudApiToken(env, {
    now: NOW,
    fetchImpl: stubFetch({ payload: freshPair('new') }, captured)
  });
  assert.equal(token, 'access-old');
  assert.equal(captured.length, 0, 'cannot refresh without token+url');
});

test('serializes concurrent callers into a single refresh (no double-use)', async () => {
  resetInFlightRefreshForTests();
  const captured: CapturedRequest[] = [];
  const env = refreshableEnv();
  const fetchImpl = stubFetch({ payload: freshPair('new') }, captured);
  const [a, b, c] = await Promise.all([
    ensureFreshCloudApiToken(env, { now: NOW, fetchImpl }),
    ensureFreshCloudApiToken(env, { now: NOW, fetchImpl }),
    ensureFreshCloudApiToken(env, { now: NOW, fetchImpl })
  ]);
  assert.equal(a, 'access-new');
  assert.equal(b, 'access-new');
  assert.equal(c, 'access-new');
  assert.equal(captured.length, 1, 'single rotation shared across concurrent callers');
});

test('throws CloudApiTokenHorizonError on 401 (horizon elapsed)', async () => {
  resetInFlightRefreshForTests();
  const env = refreshableEnv();
  await assert.rejects(
    ensureFreshCloudApiToken(env, {
      now: NOW,
      fetchImpl: stubFetch({ status: 401, rawBody: 'refresh token revoked' })
    }),
    (err: unknown) => err instanceof CloudApiTokenHorizonError
  );
  // env left unchanged on failure
  assert.equal(env.CLOUD_API_ACCESS_TOKEN, 'access-old');
});

test('throws on a non-401 refresh failure', async () => {
  resetInFlightRefreshForTests();
  const env = refreshableEnv();
  await assert.rejects(
    ensureFreshCloudApiToken(env, {
      now: NOW,
      fetchImpl: stubFetch({ status: 500, rawBody: 'boom' })
    }),
    (err: unknown) => err instanceof Error && !(err instanceof CloudApiTokenHorizonError)
  );
});

test('background refresher rotates the token on a tick within the skew window', async () => {
  resetInFlightRefreshForTests();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const captured: CapturedRequest[] = [];
    const env = refreshableEnv();
    const handle = startCloudApiTokenRefresher({
      env,
      intervalMs: 1000,
      now: NOW,
      fetchImpl: stubFetch({ payload: freshPair('loop') }, captured)
    });
    mock.timers.tick(1000);
    await flush();
    handle.stop();
    assert.equal(env.CLOUD_API_ACCESS_TOKEN, 'access-loop');
    assert.equal(env.CLOUD_API_TOKEN, 'access-loop');
    assert.equal(env.CLOUD_API_REFRESH_TOKEN, 'refresh-loop');
    assert.equal(captured.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('stop() halts the refresher before any tick fires', async () => {
  resetInFlightRefreshForTests();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const captured: CapturedRequest[] = [];
    const env = refreshableEnv();
    const handle = startCloudApiTokenRefresher({
      env,
      intervalMs: 1000,
      now: NOW,
      fetchImpl: stubFetch({ payload: freshPair('x') }, captured)
    });
    handle.stop();
    mock.timers.tick(5000);
    await flush();
    assert.equal(captured.length, 0, 'no refresh after stop()');
  } finally {
    mock.timers.reset();
  }
});

test('refresher stops and signals onHorizonElapsed on a 401', async () => {
  resetInFlightRefreshForTests();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const captured: CapturedRequest[] = [];
    const env = refreshableEnv();
    let horizonErr: unknown = null;
    startCloudApiTokenRefresher({
      env,
      intervalMs: 1000,
      now: NOW,
      fetchImpl: stubFetch({ status: 401, rawBody: 'revoked' }, captured),
      onHorizonElapsed: (err) => {
        horizonErr = err;
      }
    });
    mock.timers.tick(1000);
    await flush();
    assert.ok(horizonErr instanceof CloudApiTokenHorizonError, 'horizon callback fired');
    // loop stopped → a later tick triggers no further refresh attempt
    mock.timers.tick(5000);
    await flush();
    assert.equal(captured.length, 1, 'single attempt, then halted');
  } finally {
    mock.timers.reset();
  }
});
