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
  assert.equal(config.writebackTimeoutMs, 30_000);
  assert.equal(config.relayfileMountRoot, undefined);
});

test('loadConfig picks up RELAYFILE_MOUNT_ROOT (and RELAYFILE_ROOT as a fallback)', () => {
  const fromMountRoot = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    RELAYFILE_MOUNT_ROOT: '  /mnt/relayfile  '
  });
  assert.equal(fromMountRoot.relayfileMountRoot, '/mnt/relayfile');

  const fromLegacyAlias = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    RELAYFILE_ROOT: '/mnt/legacy'
  });
  assert.equal(fromLegacyAlias.relayfileMountRoot, '/mnt/legacy');
});

test('loadConfig honors WORKFORCE_WRITEBACK_TIMEOUT_MS', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    WORKFORCE_WRITEBACK_TIMEOUT_MS: '5000'
  });
  assert.equal(config.writebackTimeoutMs, 5000);
});

test('loadConfig normalizes the cloudUrl by stripping a trailing slash', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws',
    WORKFORCE_CLOUD_URL: 'https://cloud.example.com/'
  });
  assert.equal(config.cloudUrl, 'https://cloud.example.com');
});
