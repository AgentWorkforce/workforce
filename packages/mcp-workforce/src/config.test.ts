import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('loadConfig requires WORKFORCE_WORKSPACE_ID', () => {
  assert.throws(() => loadConfig({}), /WORKFORCE_WORKSPACE_ID is required/);
  assert.throws(() => loadConfig({ WORKFORCE_WORKSPACE_ID: '   ' }), /WORKFORCE_WORKSPACE_ID is required/);
});

test('loadConfig trims env values and applies sensible defaults', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: '  ws-demo  ',
    WORKFORCE_PERSONA_ID: ' reviewer ',
    WORKFORCE_RUNTIME_TOKEN: ' tok '
  });
  assert.equal(config.workspaceId, 'ws-demo');
  assert.equal(config.personaId, 'reviewer');
  assert.equal(config.runtimeToken, 'tok');
  assert.equal(config.cloudUrl, 'https://cloud.agentworkforce.com');
  assert.deepEqual(config.providerTokens, {});
});

test('loadConfig collects WORKFORCE_INTEGRATION_<PROVIDER>_TOKEN env vars', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    WORKFORCE_INTEGRATION_GITHUB_TOKEN: 'ghp_a',
    WORKFORCE_INTEGRATION_LINEAR_TOKEN: '  lin_b  ',
    // Empty / suffix-mismatched entries are ignored.
    WORKFORCE_INTEGRATION_EMPTY_TOKEN: '',
    WORKFORCE_INTEGRATION_GITHUB_CONNECTION_ID: 'not-a-token'
  });
  assert.deepEqual(config.providerTokens, {
    github: 'ghp_a',
    linear: 'lin_b'
  });
});

test('loadConfig normalizes the cloudUrl by stripping a trailing slash', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    WORKFORCE_CLOUD_URL: 'https://cloud.example.com/'
  });
  assert.equal(config.cloudUrl, 'https://cloud.example.com');
});
