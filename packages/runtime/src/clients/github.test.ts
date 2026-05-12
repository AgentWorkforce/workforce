import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient } from './github.js';
import { WorkforceIntegrationError } from './errors.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  handlers: Array<(call: RecordedCall) => Response | Promise<Response>>
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fakeImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const entries =
        init.headers instanceof Headers
          ? Array.from(init.headers.entries())
          : Array.isArray(init.headers)
            ? init.headers
            : Object.entries(init.headers);
      for (const [k, v] of entries) headers[k.toLowerCase()] = String(v);
    }
    const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {})
    };
    calls.push(call);
    const handler = handlers[i];
    if (!handler) throw new Error(`fakeFetch: no handler at call index ${i}`);
    i += 1;
    return handler(call);
  }) as typeof fetch;
  return { fetch: fakeImpl, calls };
}

test('createGithubClient.comment POSTs the issue comment endpoint with the right headers', async () => {
  const { fetch: fakeImpl, calls } = fakeFetch([
    () =>
      new Response(JSON.stringify({ id: 1, html_url: 'https://github.com/o/r/issues/2#issuecomment-1' }), {
        status: 201
      })
  ]);
  const client = createGithubClient({ token: 'pat_abc', fetchImpl: fakeImpl });
  const ref = await client.comment({ owner: 'o', repo: 'r', number: 2 }, 'hello');

  assert.equal(ref.number, 2);
  assert.equal(ref.url, 'https://github.com/o/r/issues/2#issuecomment-1');
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/2/comments');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer pat_abc');
  assert.equal(calls[0].headers['x-github-api-version'], '2022-11-28');
  assert.deepEqual(calls[0].body, { body: 'hello' });
});

test('createGithubClient.upsertIssue creates when no open match is found', async () => {
  const { fetch: fakeImpl, calls } = fakeFetch([
    () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    () => new Response(JSON.stringify({ number: 99, html_url: 'https://github.com/o/r/issues/99' }), { status: 201 })
  ]);
  const client = createGithubClient({ token: 't', fetchImpl: fakeImpl });
  const result = await client.upsertIssue({
    owner: 'o',
    repo: 'r',
    title: 'fresh',
    body: 'body',
    matchTitle: 'fresh',
    labels: ['digest']
  });
  assert.equal(result.created, true);
  assert.equal(result.number, 99);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/search\/issues\?q=/);
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { title: 'fresh', body: 'body', labels: ['digest'] });
});

test('createGithubClient.upsertIssue PATCHes when an open match exists', async () => {
  const { fetch: fakeImpl, calls } = fakeFetch([
    () =>
      new Response(
        JSON.stringify({
          items: [{ number: 7, title: 'weekly-digest', state: 'open', html_url: 'https://github.com/o/r/issues/7' }]
        }),
        { status: 200 }
      ),
    () => new Response(null, { status: 204 })
  ]);
  const client = createGithubClient({ token: 't', fetchImpl: fakeImpl });
  const result = await client.upsertIssue({
    owner: 'o',
    repo: 'r',
    title: 'weekly-digest',
    body: 'refreshed',
    matchTitle: 'weekly-digest'
  });
  assert.equal(result.created, false);
  assert.equal(result.number, 7);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body, { body: 'refreshed' });
});

test('createGithubClient surfaces non-2xx with WorkforceIntegrationError', async () => {
  const { fetch: fakeImpl } = fakeFetch([
    () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
  ]);
  const client = createGithubClient({ token: 't', fetchImpl: fakeImpl });
  await assert.rejects(
    () => client.comment({ owner: 'o', repo: 'r', number: 1 }, 'x'),
    (err: unknown) => {
      assert.ok(err instanceof WorkforceIntegrationError);
      assert.equal(err.provider, 'github');
      assert.equal(err.operation, 'comment');
      assert.equal(err.status, 429);
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('createGithubClient.getPr fetches the diff through the canonical API endpoint (not pr.diff_url)', async () => {
  const { fetch: fakeImpl, calls } = fakeFetch([
    () =>
      new Response(
        JSON.stringify({
          title: 't',
          body: 'b',
          head: { ref: 'feature' },
          base: { ref: 'main' },
          user: { login: 'alice' },
          // Untrusted hint the client must ignore.
          diff_url: 'https://attacker.example.com/leaked.diff'
        }),
        { status: 200 }
      ),
    () =>
      new Response('diff --git a/x b/x\n', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.v3.diff' }
      })
  ]);
  const client = createGithubClient({ token: 'pat_secret', fetchImpl: fakeImpl });
  const pr = await client.getPr({ owner: 'o', repo: 'r', number: 5 });
  assert.match(pr.diff, /^diff --git/);
  // Both requests target api.github.com, never the untrusted diff_url host.
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api\.github\.com\//);
    assert.ok(!call.url.includes('attacker.example.com'));
    assert.equal(call.headers.authorization, 'Bearer pat_secret');
  }
  // Diff call uses the diff accept header.
  assert.equal(calls[1].headers.accept, 'application/vnd.github.v3.diff');
});

test('createGithubClient surfaces 4xx as non-retryable', async () => {
  const { fetch: fakeImpl } = fakeFetch([
    () => new Response('not found', { status: 404, statusText: 'Not Found' })
  ]);
  const client = createGithubClient({ token: 't', fetchImpl: fakeImpl });
  await assert.rejects(
    () => client.comment({ owner: 'o', repo: 'r', number: 1 }, 'x'),
    (err: unknown) => {
      assert.ok(err instanceof WorkforceIntegrationError);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});
