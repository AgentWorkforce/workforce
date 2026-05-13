import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeCloudUrl, resolveCloudUrl } from './cloud-url.js';

test('canonicalizeCloudUrl: origin.agentrelay.cloud bare host → public canonical', () => {
  assert.equal(
    canonicalizeCloudUrl('https://origin.agentrelay.cloud'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: origin.agentrelay.cloud/cloud → public canonical', () => {
  assert.equal(
    canonicalizeCloudUrl('https://origin.agentrelay.cloud/cloud'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: staging.agentrelay.cloud → public canonical', () => {
  assert.equal(
    canonicalizeCloudUrl('https://staging.agentrelay.cloud'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: bare agentrelay.cloud/cloud → public canonical', () => {
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.cloud/cloud'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: public canonical is idempotent', () => {
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.com/cloud'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: trailing slash is stripped on canonical input', () => {
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.com/cloud/'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: localhost dev URLs are left untouched', () => {
  assert.equal(
    canonicalizeCloudUrl('http://localhost:3000'),
    'http://localhost:3000'
  );
});

test('canonicalizeCloudUrl: unrelated tenant URLs are left untouched', () => {
  assert.equal(
    canonicalizeCloudUrl('https://some-other-tenant.example.com'),
    'https://some-other-tenant.example.com'
  );
});

test('canonicalizeCloudUrl: empty input returns empty string', () => {
  assert.equal(canonicalizeCloudUrl(''), '');
});

test('canonicalizeCloudUrl: unparseable input is returned untouched (trimmed)', () => {
  assert.equal(canonicalizeCloudUrl('  not-a-url  '), 'not-a-url');
});

test('canonicalizeCloudUrl: apex agentrelay.com (no /cloud) → public canonical', () => {
  // Previously the CLI's DEFAULT_CLOUD_URL was `https://agentrelay.com`,
  // which sent every API call to the Next.js marketing site and 404'd.
  // canonicalizeCloudUrl normalizes that mistake before it ever leaves
  // the CLI.
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.com'),
    'https://agentrelay.com/cloud'
  );
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.com/'),
    'https://agentrelay.com/cloud'
  );
});

test('canonicalizeCloudUrl: apex with a non-root path is left untouched', () => {
  // Only the bare apex is remapped — paths like /docs are valid surface area.
  assert.equal(
    canonicalizeCloudUrl('https://agentrelay.com/docs/runtimes'),
    'https://agentrelay.com/docs/runtimes'
  );
});

test('resolveCloudUrl: flag wins over env wins over active.json wins over default', () => {
  // Flag wins.
  assert.equal(
    resolveCloudUrl({
      flag: 'https://flag.example.test',
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: 'https://env.example.test',
        WORKFORCE_CLOUD_URL: 'https://legacy-env.example.test'
      },
      active: { cloudUrl: 'https://active.example.test' }
    }),
    'https://flag.example.test'
  );

  // No flag → preferred env wins.
  assert.equal(
    resolveCloudUrl({
      env: { WORKFORCE_DEPLOY_CLOUD_URL: 'https://env.example.test' },
      active: { cloudUrl: 'https://active.example.test' }
    }),
    'https://env.example.test'
  );

  // Preferred env empty → legacy env wins.
  assert.equal(
    resolveCloudUrl({
      env: {
        WORKFORCE_DEPLOY_CLOUD_URL: '',
        WORKFORCE_CLOUD_URL: 'https://legacy-env.example.test'
      },
      active: { cloudUrl: 'https://active.example.test' }
    }),
    'https://legacy-env.example.test'
  );

  // No env → active.json wins.
  assert.equal(
    resolveCloudUrl({
      env: {},
      active: { cloudUrl: 'https://active.example.test' }
    }),
    'https://active.example.test'
  );
});

test('resolveCloudUrl: nothing set → canonical default', () => {
  assert.equal(
    resolveCloudUrl({ env: {}, active: null }),
    'https://agentrelay.com/cloud'
  );
});

test('resolveCloudUrl: active.json with bypass hostname is canonicalized', () => {
  // The active.json file may still carry an origin.* hostname written by
  // an older login flow. resolveCloudUrl repairs that on read.
  assert.equal(
    resolveCloudUrl({
      env: {},
      active: { cloudUrl: 'https://origin.agentrelay.cloud/cloud' }
    }),
    'https://agentrelay.com/cloud'
  );
});

test('resolveCloudUrl: active.json with bare apex is canonicalized', () => {
  assert.equal(
    resolveCloudUrl({
      env: {},
      active: { cloudUrl: 'https://agentrelay.com' }
    }),
    'https://agentrelay.com/cloud'
  );
});

test('resolveCloudUrl: whitespace-only candidates are skipped', () => {
  assert.equal(
    resolveCloudUrl({
      flag: '   ',
      env: { WORKFORCE_DEPLOY_CLOUD_URL: '  ', WORKFORCE_CLOUD_URL: '' },
      active: { cloudUrl: '\t\n' }
    }),
    'https://agentrelay.com/cloud'
  );
});
