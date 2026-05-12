import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceIntegrationError } from '../errors.js';
import { createSlackClient } from './slack.js';

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

test('slack post sends a cloud-proxied chat message', async () => {
  const fetchMock = mockFetch([
    { json: { ok: true, data: { ok: true, channel: 'C123', ts: '1710000000.000100' } } }
  ]);

  try {
    const client = createSlackClient({
      slackTeamId: 'T123',
      relayfileBaseUrl: 'https://relay.test',
      cloudApiToken: 'cloud-token'
    });
    const message = await client.post('C123', 'hello');

    assert.deepEqual(message, { channel: 'C123', ts: '1710000000.000100' });
    assert.equal(fetchMock.calls[0].url, 'https://relay.test/api/v1/proxy/slack');
    assert.equal((fetchMock.calls[0].init?.headers as Record<string, string>).authorization, 'Bearer cloud-token');
    assert.deepEqual(JSON.parse(String(fetchMock.calls[0].init?.body)), {
      slackTeamId: 'T123',
      endpoint: '/chat.postMessage',
      method: 'POST',
      data: { channel: 'C123', text: 'hello' }
    });
  } finally {
    fetchMock.restore();
  }
});

test('slack errors are retryable for provider 5xx responses', async () => {
  const fetchMock = mockFetch([
    { status: 503, text: 'unavailable' }
  ]);

  try {
    const client = createSlackClient({ slackTeamId: 'T123', relayfileBaseUrl: 'https://relay.test' });
    await assert.rejects(
      () => client.post('C123', 'hello'),
      (error) => {
        assert.ok(error instanceof WorkforceIntegrationError);
        assert.equal(error.provider, 'slack');
        assert.equal(error.operation, 'post');
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    fetchMock.restore();
  }
});
