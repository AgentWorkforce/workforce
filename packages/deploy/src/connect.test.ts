import test from 'node:test';
import assert from 'node:assert/strict';
import { connectIntegrations, relayfileIntegrationResolver } from './connect.js';
import { createBufferedIO } from './io.js';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('relayfileIntegrationResolver isConnected reads the cloud integration list', async () => {
  const urls: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      urls.push(String(url));
      return okJson([
        { provider: 'github', status: 'ready', connectionId: 'conn-1' }
      ]);
    }
  });
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'github' }), true);
  assert.equal(await resolver.isConnected({ workspace: 'ws-runtime', provider: 'notion' }), false);
  assert.deepEqual(urls, [
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations',
    'https://cloud.example.test/api/v1/workspaces/ws-runtime/integrations'
  ]);
});

test('relayfileIntegrationResolver reads the latest workspace token for each request', async () => {
  let token = 'old-token';
  const authHeaders: string[] = [];
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: () => token,
    fetch: async (_url, init) => {
      authHeaders.push(String(new Headers(init?.headers).get('authorization')));
      if (authHeaders.length === 1) {
        return okJson({ error: 'Unauthorized' }, 401);
      }
      return okJson([
        { provider: 'github', status: 'ready', connectionId: 'conn-1' }
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
          allowedIntegrations: ['notion']
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
