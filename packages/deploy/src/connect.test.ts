import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import {
  collectPickerInputs,
  connectIntegrations,
  relayfileCatalogConfigKeyResolver,
  relayfileIntegrationResolver,
  relayfileOptionsResolver,
  type IntegrationOptionsResolver,
  type PickerOption
} from './connect.js';
import { createBufferedIO } from './io.js';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('relayfileIntegrationResolver isConnected reads workspace provider status by default', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson({ provider: 'github', configKey: 'github-relay', ready: true });
    }
  });
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }), true);
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/github/status?scope=deployer_user'
  ]);
});

test('relayfileIntegrationResolver isConnected scopes workspace provider status checks', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson({ provider: 'github', configKey: 'github-relay', ready: true });
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
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/github/status?scope=workspace'
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
      okJson({ provider: 'slack', configKey: 'slack-ricky', ready: true })
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
      okJson({ provider: 'slack', configKey: 'slack-relay', ready: true })
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
    fetch: async () => okJson({ provider: 'slack', status: 'ready' })
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

for (const status of ['pending', 'syncing', 'degraded'] as const) {
  test(`relayfileIntegrationResolver isConnected rejects status="${status}" until ready`, async () => {
    const resolver = relayfileIntegrationResolver({
      apiUrl: 'https://cloud.example.test',
      workspaceId: 'ws-1',
      workspaceToken: 'tok',
      fetch: async () => okJson({ provider: 'slack', configKey: 'slack-relay', status })
    });
    assert.equal(
      await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
      false,
      `status="${status}" should not count as ready`
    );
  });
}

test('relayfileIntegrationResolver isConnected accepts ready runtime status as connected', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson({ provider: 'slack', configKey: 'slack-relay', status: 'ready' })
  });
  assert.equal(
    await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
    true
  );
});

test('relayfileIntegrationResolver isConnected accepts canonical OAuth-connected status before initial sync is ready', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson({
      provider: 'slack',
      configKey: 'slack-relay',
      ready: false,
      state: 'pending',
      connectionMatched: true,
      currentConnectionId: 'conn-slack',
      oauth: { connected: true }
    })
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

test('relayfileIntegrationResolver isConnected rejects OAuth status for a mismatched requested connection', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson({
      provider: 'slack',
      configKey: 'slack-relay',
      ready: false,
      state: 'pending',
      connectionMatched: false,
      currentConnectionId: 'conn-other',
      oauth: { connected: true }
    })
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

test('relayfileIntegrationResolver isConnected ignores legacy connected fields without OAuth or ready status', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () => okJson({
      provider: 'slack',
      configKey: 'slack-relay',
      connectionMatched: true,
      connected: true,
      active: true
    })
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

test('relayfileIntegrationResolver isConnected falls back to workspace scope for legacy default personas', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('scope=deployer_user')) {
        return okJson({ provider: 'slack', configKey: 'slack-relay', status: 'pending' });
      }
      return okJson({ provider: 'slack', configKey: 'slack-relay', status: 'ready' });
    }
  });

  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-runtime',
      provider: 'slack',
      expectedConfigKey: 'slack-relay',
      allowWorkspaceFallback: true
    }),
    true
  );
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=workspace'
  ]);
});

test('relayfileIntegrationResolver isConnected does not widen explicit deployer_user source', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson({ provider: 'slack', configKey: 'slack-relay', status: 'pending' });
    }
  });

  assert.equal(
    await resolver.isConnected({
      workspace: 'ws-runtime',
      provider: 'slack',
      source: { kind: 'deployer_user' },
      expectedConfigKey: 'slack-relay'
    }),
    false
  );
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=deployer_user'
  ]);
});
test('relayfileIntegrationResolver isConnected rejects status="error"', async () => {
  // A failed initial sync or errored writeback means the persona cannot
  // rely on the integration at dispatch time. Re-prompt OAuth so the user
  // can repair it instead of silently shipping a broken deploy.
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async () =>
      okJson({ provider: 'slack', configKey: 'slack-relay', status: 'error' })
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
    fetch: async () => okJson({ provider: 'slack', connectionId: 'orphan' })
  });
  assert.equal(
    await resolver.isConnected({ workspace: 'ws-1', provider: 'slack' }),
    false
  );
});

test('relayfileIntegrationResolver isConnected does NOT fall back when status returns 5xx with "404" in the body', async () => {
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
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/github/status?scope=deployer_user'
  ]);
});

test('relayfileIntegrationResolver isConnected falls back to deployer-user list matching when status 404s', async () => {
  const io = createBufferedIO();
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    io,
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/integrations/github/status')) {
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
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/github/status?scope=deployer_user',
    'https://cloud.example.test/api/v1/me/integrations'
  ]);
  assert.ok(
    io.messages.some(
      (m) => m.level === 'warn' && /integrations\/<provider>\/status/.test(m.message)
    )
  );
});

test('relayfileIntegrationResolver isConnected falls back to workspace list matching for workspace source when status 404s', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/integrations/github/status')) {
        return new Response('not found', { status: 404 });
      }
      return okJson([{ provider: 'github', status: 'ready' }]);
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
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/github/status?scope=workspace',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations'
  ]);
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
      return okJson({ provider: 'github', configKey: 'github-relay', status: 'ready' });
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

test('relayfileIntegrationResolver connects github via existing org installation without fresh install', async () => {
  const opened: string[] = [];
  const connectBodies: unknown[] = [];
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
      if (url.endsWith('/integrations/connect-session')) {
        connectBodies.push(JSON.parse(String(init?.body)));
        return okJson({
          connectLink: 'https://connect.example.test/github-oauth',
          connectionId: 'conn-oauth',
          githubInstallationFlow: {
            enabled: true,
            oauthProviderConfigKey: 'github-oauth-relay',
            installProviderConfigKey: 'github-relay'
          }
        });
      }
      if (url.endsWith('/integrations/github/reconcile')) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          oauthConnectionId: 'conn-oauth'
        });
        return okJson({
          matches: [
            {
              installationId: '9001',
              accountLogin: 'Acme',
              accountType: 'Organization',
              suspended: false
            }
          ],
          fallthrough: 'github-relay'
        });
      }
      if (url.endsWith('/integrations/github/join')) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          installationId: '9001',
          oauthConnectionId: 'conn-oauth'
        });
        return okJson({
          action: 'join',
          outcome: 'already_member',
          landingWorkspace: { id: 'ws-acme', slug: 'default', name: 'Acme Default' }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });

  assert.deepEqual(await resolver.connect({ workspace: 'ws-runtime', provider: 'github' }), {
    connectionId: 'github-installation:9001'
  });
  assert.deepEqual(opened, ['https://connect.example.test/github-oauth']);
  assert.deepEqual(connectBodies, [
    {
      allowedIntegrations: ['github'],
      scope: { kind: 'deployer_user' },
      githubInstallationFlow: true
    }
  ]);
  assert.ok(
    io.messages.some((message) =>
      message.message.includes('already connected via Acme')
    )
  );
});

test('relayfileIntegrationResolver github installation flow reads the latest workspace token while polling', async () => {
  let token = 'initial-token';
  const authHeaders: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: () => token,
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: () => undefined,
    sleep: async () => {
      token = 'refreshed-token';
    },
    fetch: async (input, init) => {
      const url = input.toString();
      authHeaders.push(String(new Headers(init?.headers).get('authorization')));
      if (url.endsWith('/integrations/connect-session')) {
        return okJson({
          connectLink: 'https://connect.example.test/github-oauth',
          connectionId: 'conn-oauth',
          githubInstallationFlow: {
            enabled: true
          }
        });
      }
      if (url.endsWith('/integrations/github/reconcile')) {
        return okJson({
          matches: [
            {
              installationId: '9001',
              accountLogin: 'Acme',
              accountType: 'Organization',
              suspended: false
            }
          ]
        });
      }
      if (url.endsWith('/integrations/github/join')) {
        return okJson({
          outcome: 'joined',
          landingWorkspace: { id: 'ws-acme' }
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });

  assert.deepEqual(await resolver.connect({ workspace: 'ws-runtime', provider: 'github' }), {
    connectionId: 'github-installation:9001'
  });
  assert.deepEqual(authHeaders, [
    'Bearer initial-token',
    'Bearer refreshed-token',
    'Bearer refreshed-token'
  ]);
});

test('relayfileIntegrationResolver github installation fallback reads the latest workspace token', async () => {
  let token = 'initial-token';
  const authHeaders: string[] = [];
  const connectBodies: unknown[] = [];
  const opened: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: () => token,
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: (url) => {
      opened.push(url);
    },
    sleep: async () => {
      token = 'refreshed-token';
    },
    fetch: async (input, init) => {
      const url = input.toString();
      authHeaders.push(String(new Headers(init?.headers).get('authorization')));
      if (url.endsWith('/integrations/connect-session')) {
        connectBodies.push(JSON.parse(String(init?.body)));
        if (connectBodies.length === 1) {
          return okJson({
            connectLink: 'https://connect.example.test/github-oauth',
            connectionId: 'conn-oauth',
            githubInstallationFlow: {
              enabled: true,
              installProviderConfigKey: 'github-relay'
            }
          });
        }
        return okJson({
          connectLink: 'https://connect.example.test/github-install',
          connectionId: 'conn-install',
          configKey: 'github-relay'
        });
      }
      if (url.endsWith('/integrations/github/reconcile')) {
        return okJson({ matches: [] });
      }
      if (url.includes('/integrations/github/status')) {
        return okJson({
          provider: 'github',
          configKey: 'github-relay',
          ready: true,
          currentConnectionId: 'conn-install'
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });

  assert.deepEqual(await resolver.connect({ workspace: 'ws-runtime', provider: 'github' }), {
    connectionId: 'conn-install'
  });
  assert.deepEqual(opened, [
    'https://connect.example.test/github-oauth',
    'https://connect.example.test/github-install'
  ]);
  assert.deepEqual(connectBodies, [
    {
      allowedIntegrations: ['github'],
      scope: { kind: 'deployer_user' },
      githubInstallationFlow: true
    },
    {
      allowedIntegrations: ['github-relay'],
      scope: { kind: 'deployer_user' }
    }
  ]);
  assert.deepEqual(authHeaders, [
    'Bearer initial-token',
    'Bearer refreshed-token',
    'Bearer refreshed-token',
    'Bearer refreshed-token'
  ]);
});

test('relayfileIntegrationResolver connect resolves when OAuth completes at workspace scope', async () => {
  const opened: string[] = [];
  const statusUrls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: (url) => {
      opened.push(url);
    },
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          allowedIntegrations: ['slack'],
          scope: { kind: 'deployer_user' }
        });
        return okJson({
          sessionUrl: 'https://connect.example.test/slack',
          connectionId: 'conn-slack'
        });
      }
      statusUrls.push(url);
      if (url.includes('scope=deployer_user')) {
        return okJson({ provider: 'slack', status: 'pending' });
      }
      return okJson({
        provider: 'slack',
        status: 'ready',
        connectionId: 'conn-slack'
      });
    }
  });

  assert.deepEqual(
    await resolver.connect({
      workspace: 'ws-runtime',
      provider: 'slack',
      allowWorkspaceFallback: true
    }),
    { connectionId: 'conn-slack' }
  );
  assert.deepEqual(opened, ['https://connect.example.test/slack']);
  assert.deepEqual(statusUrls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?connectionId=conn-slack&scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?connectionId=conn-slack&scope=workspace'
  ]);
});

test('relayfileIntegrationResolver connect reconciles canonical status when setup-session id differs', async () => {
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
        assert.equal(init?.method, 'POST');
        return okJson({
          sessionUrl: 'https://connect.example.test/slack',
          connectionId: 'setup-session-id'
        });
      }
      statusUrls.push(url);
      if (url.includes('connectionId=setup-session-id')) {
        return okJson({
          provider: 'slack',
          configKey: 'slack-relay',
          ready: false,
          state: 'pending',
          connectionMatched: false,
          currentConnectionId: 'conn-slack-final',
          oauth: { connected: true }
        });
      }
      return okJson({
        provider: 'slack',
        configKey: 'slack-relay',
        ready: false,
        state: 'pending',
        connectionMatched: true,
        currentConnectionId: 'conn-slack-final',
        oauth: { connected: true }
      });
    }
  });

  assert.deepEqual(
    await resolver.connect({ workspace: 'ws-runtime', provider: 'slack' }),
    { connectionId: 'conn-slack-final' }
  );
  assert.deepEqual(statusUrls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?connectionId=setup-session-id&scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=deployer_user'
  ]);
});

test('relayfileIntegrationResolver connect rejects canonical status with a different configKey', async () => {
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
        return okJson({
          sessionUrl: 'https://connect.example.test/slack',
          connectionId: 'setup-session-id',
          configKey: 'slack-relay'
        });
      }
      if (url.includes('connectionId=setup-session-id')) {
        return okJson({
          provider: 'slack',
          configKey: 'slack-relay',
          connectionMatched: false,
          oauth: { connected: true }
        });
      }
      return okJson({
        provider: 'slack',
        configKey: 'slack-ricky',
        connectionMatched: true,
        currentConnectionId: 'conn-slack-ricky',
        oauth: { connected: true }
      });
    }
  });

  await assert.rejects(
    resolver.connect({ workspace: 'ws-runtime', provider: 'slack' }),
    /Timed out waiting for slack OAuth/
  );
});

test('relayfileIntegrationResolver connect reconciles canonical fallback rows with a different connectionId', async () => {
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
        assert.equal(init?.method, 'POST');
        return okJson({
          sessionUrl: 'https://connect.example.test/slack',
          connectionId: 'conn-slack-new'
        });
      }
      statusUrls.push(url);
      if (url.includes('scope=deployer_user')) {
        return okJson({ provider: 'slack', status: 'pending' });
      }
      return okJson({
        provider: 'slack',
        status: 'ready',
        connectionId: 'conn-slack-other'
      });
    }
  });

  assert.deepEqual(
    await resolver.connect({
      workspace: 'ws-runtime',
      provider: 'slack',
      allowWorkspaceFallback: true
    }),
    { connectionId: 'conn-slack-other' }
  );
  assert.deepEqual(statusUrls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?connectionId=conn-slack-new&scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=deployer_user',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?connectionId=conn-slack-new&scope=workspace',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations/slack/status?scope=workspace'
  ]);
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
  assert.deepEqual(bodies, [
    {
      allowedIntegrations: ['github'],
      scope: { kind: 'deployer_user' },
      githubInstallationFlow: true
    }
  ]);
});

test('relayfileIntegrationResolver connect turns 409 unknown_provider into a "did you mean" error', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    pollIntervalMs: 0,
    timeoutMs: 100,
    openUrl: () => undefined,
    sleep: async () => undefined,
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/integrations/connect-session')) {
        return okJson(
          {
            error: 'unknown_provider',
            providers: [
              { id: 'github', vfsRoot: '/github' },
              { id: 'slack', vfsRoot: '/slack' },
              { id: 'google-mail', vfsRoot: '/google-mail' }
            ]
          },
          409
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }
  });

  await assert.rejects(resolver.connect({ workspace: 'ws-1', provider: 'gmail' }), (err: Error) => {
    assert.match(err.message, /provider "gmail" is not available/);
    assert.match(err.message, /Did you mean "google-mail"/);
    assert.match(err.message, /Valid providers: github, slack, google-mail/);
    return true;
  });
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

test('connectIntegrations --reconnect opens connect flow even when status is already ready', async () => {
  const io = createBufferedIO();
  let confirmCalled = false;
  let connectCalled = false;
  io.confirm = async () => {
    confirmCalled = true;
    return false;
  };

  const result = await connectIntegrations({
    persona: {
      id: 'linear-assistant',
      intent: 'assistant',
      description: 'test persona',
      tags: ['implementation'],
      integrations: { slack: {} }
    } as never,
    workspace: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
    noConnect: true,
    noPrompt: true,
    reconnectProviders: ['slack'],
    io,
    integrations: {
      async isConnected() {
        return true;
      },
      async connect(args) {
        connectCalled = true;
        assert.equal(args.workspace, '50587328-441d-4acb-b8f3-dbe1b3c5de99');
        assert.equal(args.provider, 'slack');
        return { connectionId: 'conn-slack' };
      }
    }
  });

  assert.equal(confirmCalled, false);
  assert.equal(connectCalled, true);
  assert.deepEqual(result.outcomes, [{ provider: 'slack', status: 'connected-now' }]);
  assert.ok(io.messages.some((message) =>
    message.level === 'info' && /reconnect requested/.test(message.message)
  ));
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

test('connectIntegrations fails useSubscription without a resolver before integration checks', async () => {
  const io = createBufferedIO();
  let integrationChecked = false;
  let integrationConnected = false;

  await assert.rejects(
    connectIntegrations({
      persona: {
        id: 'essay',
        intent: 'essay',
        description: 'test persona',
        tags: ['implementation'],
        useSubscription: true,
        integrations: { notion: {} }
      } as never,
      workspace: 'ws-1',
      noConnect: false,
      io,
      integrations: {
        async isConnected() {
          integrationChecked = true;
          return false;
        },
        async connect() {
          integrationConnected = true;
          return { connectionId: 'conn-notion' };
        }
      }
    }),
    /useSubscription:true.*no subscription connector/
  );

  assert.equal(integrationChecked, false);
  assert.equal(integrationConnected, false);
});

test('connectIntegrations connects subscription provider before integration checks', async () => {
  const io = createBufferedIO();
  const order: string[] = [];

  const result = await connectIntegrations({
    persona: {
      id: 'essay',
      intent: 'essay',
      description: 'test persona',
      tags: ['implementation'],
      useSubscription: true,
      integrations: { notion: {} }
    } as never,
    workspace: 'ws-1',
    noConnect: false,
    io,
    integrations: {
      async isConnected() {
        order.push('integration-check');
        return true;
      },
      async connect() {
        order.push('integration-connect');
        return { connectionId: 'conn-notion' };
      }
    },
    subscription: {
      async isConnected() {
        order.push('subscription-check');
        return false;
      },
      async connect() {
        order.push('subscription-connect');
        return { provider: 'anthropic' };
      }
    }
  });

  assert.deepEqual(order, ['subscription-check', 'subscription-connect', 'integration-check']);
  assert.equal(result.subscriptionProvider, 'anthropic');
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

// --- onboarding pickers ------------------------------------------------------

function personaWithBenjaminPicker(): PersonaSpec {
  return {
    inputs: {
      BENJAMIN: {
        description: 'Who to DM',
        env: 'BENJAMIN',
        optional: true,
        picker: { provider: 'slack', resource: 'users' }
      }
    }
  } as unknown as PersonaSpec;
}

function fakeOptionsResolver(
  options: PickerOption[],
  calls: Array<{ provider: string; resource: string }>
): IntegrationOptionsResolver {
  return {
    async list({ provider, resource }) {
      calls.push({ provider, resource });
      return options;
    }
  };
}

test('collectPickerInputs prompts for an unset picker input and records the pick', async () => {
  const io = createBufferedIO();
  io.scriptAnswers(['2']); // numbered-prompt fallback: choose the 2nd option
  const calls: Array<{ provider: string; resource: string }> = [];
  const resolver = fakeOptionsResolver(
    [
      { value: 'U1', label: 'Benjamin', hint: 'ben@watchdog.no' },
      { value: 'U2', label: 'Amy' }
    ],
    calls
  );

  const resolved = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: ['slack'],
    env: {}
  });

  assert.equal(resolved.BENJAMIN, 'U2');
  assert.deepEqual(calls, [{ provider: 'slack', resource: 'users' }]);
});

test('collectPickerInputs leaves an already-provided input untouched', async () => {
  const io = createBufferedIO();
  const calls: Array<{ provider: string; resource: string }> = [];
  const resolver = fakeOptionsResolver([{ value: 'U9', label: 'Nope' }], calls);

  // value present via --input
  const fromInput = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: { BENJAMIN: 'U7' },
    connectedProviders: ['slack'],
    env: {}
  });
  assert.equal(fromInput.BENJAMIN, 'U7');

  // value present via env
  const fromEnv = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: ['slack'],
    env: { BENJAMIN: 'U8' }
  });
  assert.equal(fromEnv.BENJAMIN, undefined); // not chosen; runtime resolves from env

  assert.equal(calls.length, 0); // resolver never consulted when a value exists
});

test('collectPickerInputs skips when the provider was not connected', async () => {
  const io = createBufferedIO();
  const calls: Array<{ provider: string; resource: string }> = [];
  const resolver = fakeOptionsResolver([{ value: 'U1', label: 'Benjamin' }], calls);

  const resolved = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: [], // slack not connected this run
    env: {}
  });

  assert.equal(resolved.BENJAMIN, undefined);
  assert.equal(calls.length, 0);
});

test('collectPickerInputs warns and skips when no options are available', async () => {
  const io = createBufferedIO();
  const calls: Array<{ provider: string; resource: string }> = [];
  const resolver = fakeOptionsResolver([], calls);

  const resolved = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: ['slack'],
    env: {}
  });

  assert.equal(resolved.BENJAMIN, undefined);
  assert.ok(io.messages.some((m) => m.level === 'warn' && /no slack users available/.test(m.message)));
});

test('collectPickerInputs warns and skips when the lookup throws', async () => {
  const io = createBufferedIO();
  const resolver: IntegrationOptionsResolver = {
    async list() {
      throw new Error('boom');
    }
  };

  const resolved = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: ['slack'],
    env: {}
  });

  assert.equal(resolved.BENJAMIN, undefined);
  assert.ok(io.messages.some((m) => m.level === 'warn' && /boom/.test(m.message)));
});

test('collectPickerInputs does nothing under noPrompt', async () => {
  const io = createBufferedIO();
  const calls: Array<{ provider: string; resource: string }> = [];
  const resolver = fakeOptionsResolver([{ value: 'U1', label: 'Benjamin' }], calls);

  const resolved = await collectPickerInputs({
    persona: personaWithBenjaminPicker(),
    workspace: 'ws-1',
    io,
    resolver,
    inputs: {},
    connectedProviders: ['slack'],
    env: {},
    noPrompt: true
  });

  assert.equal(resolved.BENJAMIN, undefined);
  assert.equal(calls.length, 0);
});

test('relayfileOptionsResolver normalizes the cloud options response', async () => {
  const urls: string[] = [];
  const resolver = relayfileOptionsResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson({
        ok: true,
        options: [
          { value: 'team-1', label: 'Engineering', hint: 'ENG' },
          { value: '', label: 'skip-me' },
          { label: 'no-value' }
        ]
      });
    }
  });

  const options = await resolver.list({ workspace: 'ws 1', provider: 'linear', resource: 'teams' });
  assert.deepEqual(options, [{ value: 'team-1', label: 'Engineering', hint: 'ENG' }]);
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws%201/integrations/linear/options/teams'
  ]);
});
