import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceIntegrationError } from '../errors.js';
import { createJiraClient } from './jira.js';

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

test('jira createIssue posts fields through the Atlassian cloud API', async () => {
  const fetchMock = mockFetch([
    { json: { ok: true, data: { id: '10001', key: 'ENG-1', self: 'https://jira.example/rest/api/3/issue/10001' } } }
  ]);

  try {
    const client = createJiraClient({ connectionId: 'jira_conn', relayfileBaseUrl: 'https://relay.test' });
    const issue = await client.createIssue({
      cloudId: 'cloud_1',
      fields: { project: { key: 'ENG' }, summary: 'Ship it', issuetype: { name: 'Task' } }
    });

    assert.deepEqual(issue, {
      id: '10001',
      key: 'ENG-1',
      self: 'https://jira.example/rest/api/3/issue/10001'
    });
    assert.equal(fetchMock.calls[0].url, 'https://relay.test/api/v1/proxy/jira');
    assert.deepEqual(JSON.parse(String(fetchMock.calls[0].init?.body)), {
      connectionId: 'jira_conn',
      endpoint: '/ex/jira/cloud_1/rest/api/3/issue',
      method: 'POST',
      data: { fields: { project: { key: 'ENG' }, summary: 'Ship it', issuetype: { name: 'Task' } } }
    });
  } finally {
    fetchMock.restore();
  }
});

test('jira errors are retryable for provider 5xx responses', async () => {
  const fetchMock = mockFetch([
    { status: 502, text: 'bad gateway' }
  ]);

  try {
    const client = createJiraClient({ connectionId: 'jira_conn', relayfileBaseUrl: 'https://relay.test' });
    await assert.rejects(
      () => client.createIssue({ cloudId: 'cloud_1', fields: { summary: 'Ship it' } }),
      (error) => {
        assert.ok(error instanceof WorkforceIntegrationError);
        assert.equal(error.provider, 'jira');
        assert.equal(error.operation, 'createIssue');
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    fetchMock.restore();
  }
});
