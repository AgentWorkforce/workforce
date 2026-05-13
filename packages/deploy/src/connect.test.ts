import test from 'node:test';
import assert from 'node:assert/strict';
import { relayfileIntegrationResolver } from './connect.js';
import { createBufferedIO } from './io.js';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('relayfileIntegrationResolver isConnected reads the cloud integration list', async () => {
  const resolver = relayfileIntegrationResolver({
    apiUrl: 'https://cloud.example.test',
    workspaceId: 'ws-1',
    workspaceToken: 'tok',
    fetch: async (url) => {
      assert.equal(url, 'https://cloud.example.test/api/v1/workspaces/ws-1/integrations');
      return okJson([
        { provider: 'github', status: 'ready', connectionId: 'conn-1' }
      ]);
    }
  });
  assert.equal(await resolver.isConnected({ workspace: 'ws-1', provider: 'github' }), true);
  assert.equal(await resolver.isConnected({ workspace: 'ws-1', provider: 'notion' }), false);
});

test('relayfileIntegrationResolver connect opens a session and polls until connected', async () => {
  let polls = 0;
  const opened: string[] = [];
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

  assert.deepEqual(await resolver.connect({ workspace: 'ws-1', provider: 'notion' }), {
    connectionId: 'conn-1'
  });
  assert.deepEqual(opened, ['https://connect.example.test/session']);
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
