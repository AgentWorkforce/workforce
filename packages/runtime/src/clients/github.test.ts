import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceIntegrationError } from '../errors.js';
import { createGithubClient } from './github.js';

function mockFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, `unexpected fetch call to ${String(input)}`);
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? {})
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('github createIssue posts through the provider proxy', async () => {
  const fetchMock = mockFetch([
    { json: { ok: true, data: { number: 42, html_url: 'https://github.com/acme/app/issues/42' } } }
  ]);

  try {
    const client = createGithubClient({ connectionId: 'conn_1', relayfileBaseUrl: 'https://relay.test/' });
    const issue = await client.createIssue({
      owner: 'acme',
      repo: 'app',
      title: 'Bug',
      body: 'Details',
      labels: ['triage']
    });

    assert.deepEqual(issue, { number: 42, url: 'https://github.com/acme/app/issues/42' });
    assert.equal(fetchMock.calls[0].url, 'https://relay.test/api/v1/proxy/github');
    assert.deepEqual(JSON.parse(String(fetchMock.calls[0].init?.body)), {
      connectionId: 'conn_1',
      endpoint: '/repos/acme/app/issues',
      method: 'POST',
      data: { title: 'Bug', body: 'Details', labels: ['triage'] }
    });
  } finally {
    fetchMock.restore();
  }
});

test('github errors are retryable for provider 5xx responses', async () => {
  const fetchMock = mockFetch([
    { status: 500, text: 'server failed' }
  ]);

  try {
    const client = createGithubClient({ connectionId: 'conn_1', relayfileBaseUrl: 'https://relay.test' });
    await assert.rejects(
      () => client.createIssue({ owner: 'acme', repo: 'app', title: 'Bug', body: 'Details' }),
      (error) => {
        assert.ok(error instanceof WorkforceIntegrationError);
        assert.equal(error.provider, 'github');
        assert.equal(error.operation, 'createIssue');
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    fetchMock.restore();
  }
});
