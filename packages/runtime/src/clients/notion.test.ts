import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceIntegrationError } from '../errors.js';
import { createNotionClient } from './notion.js';

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

test('notion createPage posts parent, properties, and children', async () => {
  const fetchMock = mockFetch([
    { json: { ok: true, data: { id: 'page_1', url: 'https://notion.so/page_1' } } }
  ]);

  try {
    const client = createNotionClient({ connectionId: 'notion_conn', relayfileBaseUrl: 'https://relay.test' });
    const page = await client.createPage(
      { database_id: 'db_1' },
      { Name: { title: [{ text: { content: 'Digest' } }] } },
      [{ object: 'block', type: 'paragraph' }]
    );

    assert.deepEqual(page, { id: 'page_1', url: 'https://notion.so/page_1' });
    assert.equal(fetchMock.calls[0].url, 'https://relay.test/api/v1/proxy/notion');
    assert.deepEqual(JSON.parse(String(fetchMock.calls[0].init?.body)), {
      connectionId: 'notion_conn',
      endpoint: '/v1/pages',
      method: 'POST',
      data: {
        parent: { database_id: 'db_1' },
        properties: { Name: { title: [{ text: { content: 'Digest' } }] } },
        children: [{ object: 'block', type: 'paragraph' }]
      },
      headers: { 'notion-version': '2022-06-28' }
    });
  } finally {
    fetchMock.restore();
  }
});

test('notion errors are retryable for provider 429 responses', async () => {
  const fetchMock = mockFetch([
    { status: 429, text: 'rate limited' }
  ]);

  try {
    const client = createNotionClient({ connectionId: 'notion_conn', relayfileBaseUrl: 'https://relay.test' });
    await assert.rejects(
      () => client.getPage('page_1'),
      (error) => {
        assert.ok(error instanceof WorkforceIntegrationError);
        assert.equal(error.provider, 'notion');
        assert.equal(error.operation, 'getPage');
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    fetchMock.restore();
  }
});
