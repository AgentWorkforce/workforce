import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectIntegrations,
  relayfileCatalogConfigKeyResolver,
  relayfileIntegrationResolver
} from './connect.js';
import { createBufferedIO } from './io.js';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('relayfileIntegrationResolver isConnected defaults to /me/integrations (deployer_user)', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson([
        { provider: 'github', providerConfigKey: 'github-relay', status: 'ready' }
      ]);
    }
  });
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }), true);
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'notion' }), false);
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/me/integrations',
    'https://cloud.example.test/api/v1/me/integrations'
  ]);
});

test('relayfileIntegrationResolver isConnected hits /workspaces/<id>/integrations for workspace source', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson([
        { provider: 'github', providerConfigKey: 'github-relay', status: 'ready' }
      ]);
    }
  });
  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-runtime',
      provider: 'github',
      source: { kind: 'workspace' }
    }),
    true
  );
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations'
  ]);
});

test('relayfileIntegrationResolver isConnected rejects rows whose providerConfigKey does not match', async () => {
  // Workspace has slack-ricky connected. Persona declares plain `slack`, which
  // should resolve to slack-relay. The row exists with provider:'slack' but
  // backed by a different config-key → must NOT count as connected.
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () =>
      okJson([{ provider: 'slack', providerConfigKey: 'slack-ricky', status: 'ready' }])
  });
  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-1',
      provider: 'slack',
      expectedConfigKey: 'slack-relay'
    }),
    false
  );
});

test('relayfileIntegrationResolver isConnected accepts a matching providerConfigKey', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () =>
      okJson([{ provider: 'slack', providerConfigKey: 'slack-relay', status: 'ready' }])
  });
  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-1',
      provider: 'slack',
      expectedConfigKey: 'slack-relay'
    }),
    true
  );
});

test('relayfileIntegrationResolver isConnected falls back to provider-name match when row lacks providerConfigKey', async () => {
  // Older cloud (pre cloud#988) returns rows without providerConfigKey. To
  // avoid hard-failing every deploy until that ships, the matcher treats a
  // missing field as "trust the server" and matches by provider name only.
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson([{ provider: 'slack', status: 'ready' }])
  });
  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-1',
      provider: 'slack',
      expectedConfigKey: 'slack-relay'
    }),
    true
  );
});

for (const status of ['ready', 'pending', 'syncing', 'degraded'] as const) {
  test(`relayfileIntegrationResolver isConnected accepts status="${status}" as connected`, async () => {
    const resolver = relayfileIntegrationResolver({
      apiUrl: 'https://cloud.example.test',
      workspaceId: 'ws-1',
      workspaceToken: 'tok',
      fetch: async () => okJson([{ provider: 'slack', providerConfigKey: 'slack-relay', status }])
    });
    assert.equal(
      await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
      true,
      `status="${status}" should count as connected`
    );
  });
}

test('relayfileIntegrationResolver isConnected rejects status="error"', async () => {
  // A failed initial sync or errored writeback means the persona cannot
  // rely on the integration at dispatch time. Re-prompt OAuth so the user
  // can repair it instead of silently shipping a broken deploy.
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () =>
      okJson([{ provider: 'slack', providerConfigKey: 'slack-relay', status: 'error' }])
  });
  assert.equal(
    await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
    false
  );
});

test('relayfileIntegrationResolver isConnected ignores rows with only a connectionId (no status)', async () => {
  // The previous matcher treated any truthy connectionId as connected. That
  // caused false positives whenever an abandoned OAuth left an orphan row.
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson([{ provider: 'slack', connectionId: 'orphan' }])
  });
  assert.equal(
    await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
    false
  );
});

test('relayfileIntegrationResolver isConnected does NOT fall back when /me/integrations returns 5xx with "404" in the body', async () => {
  // Regression: previous implementation regex-matched "404" anywhere in the
  // error message and treated a 500 whose body mentioned "/api/v1/foo/404"
  // (or any other 404 substring) as a missing-endpoint signal. The check
  // must use the explicit HTTP status, not the body text.
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return new Response('upstream timeout (request 404abc failed)', { status: 500 });
    }
  });
  await assert.rejects(
    resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }),
    /cloud integration request failed: 500/
  );
  // Only the /me call should have happened — no silent fallback to workspace.
  assert.deepEqual(urls, ['https://cloud.example.test/api/v1/me/integrations']);
});

test('relayfileIntegrationResolver isConnected falls back to workspace endpoint when /me/integrations 404s', async () => {
  const io = createBufferedIO();
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    io,
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/me/integrations')) {
        return new Response('not found', { status: 404 });
      }
      return okJson([{ provider: 'github', status: 'ready' }]);
    }
  });
  assert.equal(
    await resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }),
    true
  );
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/me/integrations',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations'
  ]);
  assert.ok(
    io.messages.some(
      (m) => m.level === 'warn' && /me\/integrations/.test(m.message)
    )
  );
});

test('relayfileCatalogConfigKeyResolver returns the expected configKey and caches the catalog', async () => {
  let calls = 0;
  const resolver = relayfileCatalogConfigKeyResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceToken: 'tok',
    fetch: async () => {
      calls += 1;
      return okJson({
        providers: [
          { id: 'slack', configKey: 'slack-relay' },
          { id: 'github', configKey: 'github-relay' }
        ]
      });
    }
  });
  assert.equal(await resolver.resolve('slack'), 'slack-relay');
  assert.equal(await resolver.resolve('github'), 'github-relay');
  assert.equal(await resolver.resolve('unknown'), undefined);
  assert.equal(calls, 1, 'catalog should be fetched exactly once and cached');
});

test('relayfileCatalogConfigKeyResolver returns undefined for every provider when catalog fetch fails', async () => {
  const io = createBufferedIO();
  const resolver = relayfileCatalogConfigKeyResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceToken: 'tok',
    io,
    fetch: async () => new Response('boom', { status: 500 })
  });
  assert.equal(await resolver.resolve('slack'), undefined);
  assert.ok(io.messages.some((m) => m.level === 'warn' && /catalog/.test(m.message)));
});

test('relayfileIntegrationResolver reads the latest workspace token for each request', async () => {
  let token = 'old-token';
  const authHeaders: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: () => token,
    fetch: async (_url, init) => {
      const auth = String(new Headers(init?.headers).get('authorization'));
      authHeaders.push(auth);
      if (auth === 'Bearer old-token') {
        return okJson({ error: 'Unauthorized' }, 401);
      }
      return okJson([
        { provider: 'github', providerConfigKey: 'github-relay', status: 'ready' }
      ]);
    }
  });

  await assert.rejects(
    resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }),
    /unauthorized/
  );
  token = 'new-token';
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }), true);
  assert.deepEqual(authHeaders, ['Bearer old-token', 'Bearer new-token']);
});

test('relayfileIntegrationResolver connect opens a session and polls until connected', async () => {
  let polls = 0;
  const opened: string[] = [];
  const urls: string[] = [];
  const io = createBufferedIO();
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    io,
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: (url) => {
      opened.push(url);
    },
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = input.toString();
      urls.push(url);
      if (url.endsWith('/integrations/connect-session')) {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          allowedIntegrations: ['notion'],
          scope: { kind: 'deployer_user' }
        });
        return okJson({ connectLink: 'https://connect.example.test/session', connectionId: 'conn-1' });
      }
      if (url.includes('/integrations/notion/status')) {
        polls += 1;
        return okJson(
          polls < 3
            ? { ready: false, state: 'pending' }
            : { ready: true, state: 'ready', currentConnectionId: 'conn-1' }
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });

  assert.deepEqual(await resolver.connect({ workspace: 'ws-runtime', provider: 'notion' }), {
    connectionId: 'conn-1'
  });
  assert.deepEqual(opened, ['https://connect.example.test/session']);
  assert.ok(urls.every((url) => url.includes('/workspaces/ws-runtime/')));
  assert.equal(polls, 3);
  assert.ok(io.messages.some((message) => message.message.includes('notion connected')));
});

test('relayfileIntegrationResolver connect sends scope=workspace and scopes status polls (workspace source)', async () => {
  const bodies: unknown[] = [];
  const statusUrls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: () => undefined,
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        bodies.push(JSON.parse(String(init?.body)));
        return okJson({ sessionUrl: 'https://connect.example.test/session', connectionId: 'conn-ws' });
      }
      statusUrls.push(url);
      return okJson({ status: 'ready', connectionId: 'conn-ws' });
    }
  });
  await resolver.connect({ workspace: 'ws-1', provider: 'github', source: { kind: 'workspace' } });
  assert.deepEqual(bodies, [{ allowedIntegrations: ['github'], scope: { kind: 'workspace' } }]);
  assert.ok(statusUrls.every((u) => u.includes('scope=workspace')));
});

test('relayfileIntegrationResolver connect sends scope=workspace_service_account + name', async () => {
  const bodies: unknown[] = [];
  const statusUrls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: () => undefined,
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        bodies.push(JSON.parse(String(init?.body)));
        return okJson({ sessionUrl: 'https://connect.example.test/session', connectionId: 'conn-sa' });
      }
      statusUrls.push(url);
      return okJson({ status: 'ready', connectionId: 'conn-sa' });
    }
  });
  await resolver.connect({
    workspace: 'ws-1',
    provider: 'github',
    source: { kind: 'workspace_service_account', name: 'release-bot' }
  });
  assert.deepEqual(bodies, [
    {
      allowedIntegrations: ['github'],
      scope: { kind: 'workspace_service_account', name: 'release-bot' }
    }
  ]);
  assert.ok(statusUrls.every((u) => u.includes('scope=workspace_service_account')));
  assert.ok(statusUrls.every((u) => u.includes('serviceAccountName=release-bot')));
});

test('relayfileIntegrationResolver connect defaults to deployer_user when source omitted', async () => {
  const bodies: unknown[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: () => undefined,
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        bodies.push(JSON.parse(String(init?.body)));
        return okJson({ sessionUrl: 'https://connect.example.test/session', connectionId: 'conn-du' });
      }
      return okJson({ status: 'ready', connectionId: 'conn-du' });
    }
  });
  await resolver.connect({ workspace: 'ws-1', provider: 'github' });
  assert.deepEqual(bodies, [{ allowedIntegrations: ['github'], scope: { kind: 'deployer_user' } }]);
});

test('relayfileIntegrationResolver connect times out clearly', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 1,
    openUrl: () => undefined,
    sleep: async () => undefined,
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        return okJson({ sessionUrl: 'https://connect.example.test/session' });
      }
      return okJson({ ready: false, state: 'pending' });
    }
  });
  await assert.rejects(
    resolver.connect({ workspace: 'ws-1', provider: 'github' }),
    /Timed out waiting for github OAuth/
  );
});

test('connectIntegrations fails fast on auth errors without prompting to connect', async () => {
  const io = createBufferedIO();
  let connectCalled = false;
  let confirmCalled = false;
  io.confirm = async () => {
    confirmCalled = true;
    return true;
  };

  const result = await connectIntegrations({
    persona: {
      id: 'essay',
      intent: 'essay',
      description: 'test persona',
      tags: ['implementation'],
      integrations: { notion: {} }
    } as never,
    workspace: 'ws-1',
    noConnect: false,
    io,
    integrations: {
      async isConnected() {
        throw new Error(
          'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.'
        );
      },
      async connect() {
        connectCalled = true;
        throw new Error('connect should not be called after auth failure');
      }
    }
  });

  assert.equal(confirmCalled, false);
  assert.equal(connectCalled, false);
  assert.equal(result.outcomes.length, 1);
  const [outcome] = result.outcomes;
  assert.equal(outcome.provider, 'notion');
  assert.equal(outcome.status, 'failed');
  // Future-proofed against copy-edits: the message must point users at the
  // workforce CLI's own login and must NOT instruct them to reach for the
  // upstream `agent-relay` binary.
  assert.match(outcome.message ?? '', /agentworkforce login/i);
  assert.doesNotMatch(outcome.message ?? '', /agent-relay cloud/);
  assert.ok(io.messages.some((message) => message.level === 'warn' && message.message.includes('failed to check connection status for notion')));
  assert.ok(io.messages.some((message) => message.level === 'error' && message.message.includes('auth failed')));
});

test('relayfileIntegrationResolver surfaces the agentworkforce-native error on 401', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => new Response('Unauthorized', { status: 401 })
  });
  await assert.rejects(
    resolver.isConnected({ workspace: 'ws-1', provider: 'notion' }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /unauthorized/i);
      assert.match(message, /agentworkforce login/i);
      assert.doesNotMatch(message, /agent-relay cloud/);
      assert.doesNotMatch(message, /origin\.agentrelay\.cloud/);
      return true;
    }
  );
});

test('connectIntegrations prompts auth recovery on unauthorized status checks and retries', async () => {
  const io = createBufferedIO();
  let checks = 0;
  let recoverCalled = false;
  let connectCalled = false;

  const result = await connectIntegrations({
    persona: {
      id: 'essay',
      intent: 'essay',
      description: 'test persona',
      tags: ['implementation'],
      integrations: { notion: {} }
    } as never,
    workspace: 'ws-1',
    noConnect: false,
    io,
    integrations: {
      async isConnected() {
        checks += 1;
        if (checks === 1) {
          throw new Error(
            'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.'
          );
        }
        return true;
      },
      async connect() {
        connectCalled = true;
        throw new Error('connect should not be called after auth recovery');
      }
    },
    authRecovery: {
      async recover({ workspace, provider }) {
        recoverCalled = true;
        assert.equal(workspace, 'ws-1');
        assert.equal(provider, 'notion');
        return true;
      }
    }
  });

  assert.equal(recoverCalled, true);
  assert.equal(connectCalled, false);
  assert.equal(checks, 2);
  assert.deepEqual(result.outcomes, [{ provider: 'notion', status: 'already-connected' }]);
});

test('connectIntegrations does not prompt auth recovery when --no-prompt is set', async () => {
  const io = createBufferedIO();
  let recoverCalled = false;

  const result = await connectIntegrations({
    persona: {
      id: 'essay',
      intent: 'essay',
      description: 'test persona',
      tags: ['implementation'],
      integrations: { notion: {} }
    } as never,
    workspace: 'ws-1',
    noConnect: true,
    noPrompt: true,
    io,
    integrations: {
      async isConnected() {
        throw new Error(
          'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.'
        );
      },
      async connect() {
        throw new Error('connect should not be called after auth failure');
      }
    },
    authRecovery: {
      async recover() {
        recoverCalled = true;
        return true;
      }
    }
  });

  assert.equal(recoverCalled, false);
  assert.deepEqual(result.outcomes, [
    {
      provider: 'notion',
      status: 'failed',
      message:
        'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.'
    }
  ]);
});

test('connectIntegrations fails status-check errors without opening a connect flow', async () => {
  const io = createBufferedIO();
  let connectCalled = false;

  const result = await connectIntegrations({
    persona: {
      id: 'essay',
      intent: 'essay',
      description: 'test persona',
      tags: ['implementation'],
      integrations: { notion: {} }
    } as never,
    workspace: 'ws-1',
    noConnect: false,
    io,
    integrations: {
      async isConnected() {
        throw new Error('cloud integration request failed: 503 Service Unavailable');
      },
      async connect() {
        connectCalled = true;
        throw new Error('connect should not be called after status-check failure');
      }
    }
  });

  assert.equal(connectCalled, false);
  assert.deepEqual(result.outcomes, [
    {
      provider: 'notion',
      status: 'failed',
      message: 'cloud integration request failed: 503 Service Unavailable'
    }
  ]);
  assert.ok(io.messages.some((message) => message.level === 'error' && message.message.includes('failed while checking connection status')));
});

test('connectIntegrations honors --no-prompt for subscription provider setup', async () => {
  const io = createBufferedIO();
  let confirmCalled = false;
  let subscriptionConnectCalled = false;
  io.confirm = async () => {
    confirmCalled = true;
    return true;
  };

  await assert.rejects(
    connectIntegrations({
      persona: {
        id: 'essay',
        intent: 'essay',
        description: 'test persona',
        tags: ['implementation'],
        useSubscription: true,
        integrations: {}
      } as never,
      workspace: 'ws-1',
      noConnect: false,
      noPrompt: true,
      io,
      integrations: {
        async isConnected() {
          throw new Error('no integration checks expected');
        },
        async connect() {
          throw new Error('no integration connects expected');
        }
      },
      subscription: {
        async isConnected() {
          return false;
        },
        async connect() {
          subscriptionConnectCalled = true;
          return { provider: 'anthropic' };
        }
      }
    }),
    /--no-prompt was passed/
  );

  assert.equal(confirmCalled, false);
  assert.equal(subscriptionConnectCalled, false);
});
