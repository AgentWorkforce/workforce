import test from 'node:test';
import assert from 'node:assert/strict';
import { listIntegrationsTool } from './list-integrations.js';
import type { IntegrationsDocument, ListIntegrationsOptions } from '@agentworkforce/deploy';
import type { WorkforceMcpConfig } from '../config.js';

const config: WorkforceMcpConfig = {
  workspaceId: 'ws-1',
  runtimeToken: 'tok',
  cloudUrl: 'https://cloud.example.test',
  writebackTimeoutMs: 30_000
};

const fixture: IntegrationsDocument = {
  workspaceId: 'ws-1',
  auth: 'authenticated',
  integrations: [
    {
      id: 'google-mail',
      adapterSlug: 'gmail',
      inCloudCatalog: true,
      connected: true,
      connections: [
        {
          connectionId: 'conn-gmail',
          scope: 'deployer_user',
          serviceAccountName: null,
          status: 'ready'
        }
      ],
      triggers: ['message.received'],
      triggerSource: 'catalog'
    }
  ],
  warnings: []
};

test('listIntegrationsTool routes workspace, token, provider, and includeTriggers to deploy core', async () => {
  const seen: ListIntegrationsOptions[] = [];
  const result = await listIntegrationsTool(
    { provider: 'gmail', includeTriggers: false },
    {
      config,
      listIntegrations: async (options = {}) => {
        seen.push(options);
        return {
          ...fixture,
          integrations: fixture.integrations.map((row) => ({
            ...row,
            triggers: options.includeTriggers === false ? [] : row.triggers,
            triggerSource: options.includeTriggers === false ? 'none' : row.triggerSource
          }))
        };
      }
    }
  );

  const options = seen[0];
  assert.ok(options);
  assert.equal(options.workspaceId, 'ws-1');
  assert.equal(options.token, 'tok');
  assert.equal(options.cloudUrl, 'https://cloud.example.test');
  assert.equal(options.provider, 'gmail');
  assert.equal(options.includeTriggers, false);
  assert.deepEqual(result.integrations[0].triggers, []);
  assert.equal(result.integrations[0].triggerSource, 'none');
});

test('listIntegrationsTool does not consult local login when runtimeToken is missing', async () => {
  const seen: ListIntegrationsOptions[] = [];
  await listIntegrationsTool(
    {},
    {
      config: {
        ...config,
        runtimeToken: undefined
      },
      listIntegrations: async (options = {}) => {
        seen.push(options);
        return { ...fixture, auth: 'unauthenticated', workspaceId: 'ws-1' };
      }
    }
  );
  const options = seen[0];
  assert.ok(options);
  assert.equal(options.token, undefined);
  assert.equal(options.activeWorkspace, null);
  assert.ok(options.resolveWorkspaceToken);
  await assert.rejects(options.resolveWorkspaceToken({
    cloudUrl: 'https://cloud.example.test',
    io: {
      info() {},
      warn() {},
      error() {},
      async confirm() {
        return false;
      },
      async prompt() {
        return '';
      }
    },
    noPrompt: true
  }));
});
