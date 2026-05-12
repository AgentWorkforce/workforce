import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceIntegrationError } from '../errors.js';
import { createLinearClient } from './linear.js';

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

test('linear createIssue posts a GraphQL mutation through the provider proxy', async () => {
  const fetchMock = mockFetch([
    { json: { ok: true, data: { data: { issueCreate: { issue: { id: 'i1', identifier: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' } } } } } }
  ]);

  try {
    const client = createLinearClient({ connectionId: 'linear_conn', relayfileBaseUrl: 'https://relay.test' });
    const issue = await client.createIssue({ teamId: 'team_1', title: 'Ship it', description: 'Soon' });

    assert.deepEqual(issue, { id: 'i1', identifier: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' });
    assert.equal(fetchMock.calls[0].url, 'https://relay.test/api/v1/proxy/linear');
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.connectionId, 'linear_conn');
    assert.equal(body.endpoint, '/graphql');
    assert.equal(body.method, 'POST');
    assert.match(body.data.query, /CreateIssue/);
  } finally {
    fetchMock.restore();
  }
});

test('linear errors are retryable for provider 429 responses', async () => {
  const fetchMock = mockFetch([
    { status: 429, text: 'rate limited' }
  ]);

  try {
    const client = createLinearClient({ connectionId: 'linear_conn', relayfileBaseUrl: 'https://relay.test' });
    await assert.rejects(
      () => client.getIssue('ENG-1'),
      (error) => {
        assert.ok(error instanceof WorkforceIntegrationError);
        assert.equal(error.provider, 'linear');
        assert.equal(error.operation, 'getIssue');
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    fetchMock.restore();
  }
});
