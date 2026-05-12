import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchIntegration, _resetIntegrationCache } from './integrations.js';
import type { WorkforceMcpConfig } from '../config.js';

function config(over: Partial<WorkforceMcpConfig> = {}): WorkforceMcpConfig {
  return {
    workspaceId: 'ws-demo',
    cloudUrl: 'https://cloud.example.com',
    providerTokens: { github: 'ghp_secret' },
    ...over
  };
}

test('dispatchIntegration rejects malformed tool names', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () => dispatchIntegration('integration.github', {}, { config: config() }),
    /must be "integration\.<provider>\.<method>"/
  );
  await assert.rejects(
    () => dispatchIntegration('memory.save', {}, { config: config() }),
    /must be "integration\.<provider>\.<method>"/
  );
});

test('dispatchIntegration rejects unwired providers', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () => dispatchIntegration('integration.linear.createIssue', {}, { config: config() }),
    /integration provider "linear" is not wired/
  );
});

test('dispatchIntegration rejects when the provider token is missing', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () =>
      dispatchIntegration(
        'integration.github.comment',
        { target: { owner: 'o', repo: 'r', number: 1 }, body: 'x' },
        { config: config({ providerTokens: {} }) }
      ),
    /WORKFORCE_INTEGRATION_GITHUB_TOKEN/
  );
});

test('dispatchIntegration forwards integration.github.comment to the github client', async (t) => {
  _resetIntegrationCache();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    return new Response(
      JSON.stringify({ id: 99, html_url: 'https://github.com/o/r/issues/1#issuecomment-99' }),
      { status: 201 }
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    _resetIntegrationCache();
  });

  const result = await dispatchIntegration(
    'integration.github.comment',
    { target: { owner: 'o', repo: 'r', number: 1 }, body: 'hello' },
    { config: config() }
  );
  assert.deepEqual(result, { number: 1, url: 'https://github.com/o/r/issues/1#issuecomment-99' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/1/comments');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { body: 'hello' });
});

test('dispatchIntegration validates github.postReview event enum', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () =>
      dispatchIntegration(
        'integration.github.postReview',
        {
          target: { owner: 'o', repo: 'r', number: 1 },
          review: { body: 'lgtm', event: 'WAVE' }
        },
        { config: config() }
      ),
    /review\.event must be one of/
  );
});

test('dispatchIntegration surfaces missing required fields with field-pointed errors', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () =>
      dispatchIntegration(
        'integration.github.createIssue',
        { owner: 'o', repo: '', title: 't', body: 'b' },
        { config: config() }
      ),
    /repo: must be a non-empty string/
  );
});
