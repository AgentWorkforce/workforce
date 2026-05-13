import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeCloudUrl } from './cloud-url.js';

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
