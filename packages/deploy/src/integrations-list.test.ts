import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IntegrationsListError,
  UnknownIntegrationProviderError,
  listIntegrations
} from './integrations-list.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('listIntegrations merges cloud catalog, trigger catalog aliases, and connection state', async () => {
  const calls: string[] = [];
  const document = await listIntegrations({
    workspaceId: 'ws-1',
    token: 'tok',
    client: {
      async fetch(pathname) {
        calls.push(pathname);
        if (pathname === '/api/v1/integrations/catalog') {
          return json({
            providers: [
              { id: 'acme-internal', configKey: 'secret-config-key' },
              { id: 'github', configKey: 'github-relay' },
              { id: 'google-mail', configKey: 'gmail-relay' }
            ]
          });
        }
        if (pathname === '/api/v1/me/integrations') {
          return json({
            integrations: [
              {
                provider: 'google-mail',
                connectionId: 'conn-user-gmail',
                scope: 'deployer_user',
                status: 'ready'
              }
            ]
          });
        }
        if (pathname === '/api/v1/workspaces/ws-1/integrations') {
          return json({
            integrations: [
              {
                provider: 'github',
                connectionId: 'conn-workspace-github',
                scope: 'workspace',
                status: 'ready'
              }
            ]
          });
        }
        if (pathname.includes('/status?scope=deployer_user')) {
          return json({ provider: pathname.includes('google-mail') ? 'google-mail' : 'other', status: 'pending' });
        }
        if (pathname.includes('/status?scope=workspace')) {
          return json({ provider: pathname.includes('github') ? 'github' : 'other', status: 'pending' });
        }
        return json({ error: 'unexpected' }, 500);
      }
    }
  });

  const googleMail = document.integrations.find((row) => row.id === 'google-mail');
  assert.ok(googleMail);
  assert.equal(googleMail.adapterSlug, 'gmail');
  assert.equal(googleMail.inCloudCatalog, true);
  assert.equal(googleMail.connected, true);
  assert.ok(googleMail.triggers.length > 0);
  assert.equal(googleMail.triggerSource, 'catalog');
  assert.equal(googleMail.connections?.some((c) => c.connectionId === 'conn-user-gmail'), true);

  const acme = document.integrations.find((row) => row.id === 'acme-internal');
  assert.ok(acme);
  assert.equal(acme.triggerSource, 'none');
  assert.deepEqual(acme.triggers, []);

  assert.equal(JSON.stringify(document).includes('configKey'), false);
  assert.equal(JSON.stringify(document).includes('secret-config-key'), false);
  assert.equal(calls.includes('/api/v1/me/integrations'), true);
  assert.equal(calls.includes('/api/v1/workspaces/ws-1/integrations'), true);
});

test('listIntegrations returns partial trigger-catalog document when unauthenticated and cloud catalog is unavailable', async () => {
  const document = await listIntegrations({
    activeWorkspace: null,
    env: {},
    async resolveWorkspaceToken() {
      throw new Error('missing login');
    },
    fetch: async () => json({ error: 'offline' }, 503)
  });

  assert.equal(document.auth, 'unauthenticated');
  assert.equal(document.workspaceId, null);
  assert.ok(document.integrations.length > 0);
  assert.ok(document.integrations.every((row) => row.connected === null));
  assert.ok(document.integrations.every((row) => row.connections === null));
  assert.ok(document.integrations.every((row) => row.inCloudCatalog === false));
  assert.match(document.warnings.join('\n'), /cloud integration catalog unavailable/);
  assert.match(document.warnings.join('\n'), /partial, cloud-only\/connect-only integrations omitted/);
});

test('listIntegrations throws loud endpoint errors while authenticated', async () => {
  await assert.rejects(
    listIntegrations({
      workspaceId: 'ws-1',
      token: 'tok',
      client: {
        async fetch(pathname) {
          if (pathname === '/api/v1/integrations/catalog') {
            return json({ providers: [{ id: 'github' }] });
          }
          return new Response('server down', { status: 502 });
        }
      }
    }),
    (err) => {
      assert.ok(err instanceof IntegrationsListError);
      assert.equal(err.status, 502);
      assert.match(err.message, /server down/);
      return true;
    }
  );
});

test('listIntegrations accepts adapter slug as provider filter and suggests it on unknown providers', async () => {
  const base = {
    activeWorkspace: null,
    async resolveWorkspaceToken() {
      throw new Error('missing login');
    },
    fetch: async () => json({ providers: [{ id: 'google-mail' }] })
  };
  const document = await listIntegrations({ ...base, provider: 'gmail' });
  assert.deepEqual(document.integrations.map((row) => row.id), ['google-mail']);

  await assert.rejects(
    listIntegrations({ ...base, provider: 'gmal' }),
    (err) => {
      assert.ok(err instanceof UnknownIntegrationProviderError);
      assert.equal(err.suggestion, 'google-mail');
      return true;
    }
  );
});
