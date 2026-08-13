import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RelayhistoryTurnWriter } from './relayhistory-turn-writer.js';

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

test('writes turns with stable session attribution and increasing turn indexes', async () => {
  const requests: CapturedRequest[] = [];
  const { baseUrl, close } = await captureServer(requests, 3);
  const previousToken = process.env.RELAYHISTORY_ACCESS_TOKEN;
  process.env.RELAYHISTORY_ACCESS_TOKEN = 'rth_at_test';

  try {
    const writer = new RelayhistoryTurnWriter({
      relaySessionId: 'session/with spaces',
      sessionOwner: 'Danny',
      actorName: 'runtime-agent',
      relayhistoryUrl: `${baseUrl}/`,
      orgId: 'org-a'
    });

    writer.writeTurn({ role: 'user', content: 'Start the task' });
    writer.writeTurn({
      role: 'assistant',
      content: 'Done',
      actorName: 'specialist'
    });
    writer.writeSessionMetadata({
      nativeCli: 'codex',
      nativeResumeId: 'codex-resume-123'
    });

    await waitFor(() => requests.length === 3);

    const turns = requests
      .map((request) => {
        const body = request.body as { turns: Array<Record<string, unknown>> };
        return body.turns[0]!;
      })
      .sort((left, right) => Number(left.turnIndex) - Number(right.turnIndex));

    assert.equal(requests[0]?.url, '/v1/sessions/session%2Fwith%20spaces/turns');
    assert.equal(requests[0]?.headers.authorization, 'Bearer rth_at_test');
    assert.equal(requests[0]?.headers['x-org-id'], 'org-a');
    assert.ok(requests.every((request) => request.body.sessionOwner === 'Danny'));
    assert.deepEqual(
      turns.map((turn) => turn.turnIndex),
      [0, 1, 2]
    );
    assert.deepEqual(turns[0], {
      role: 'user',
      content: 'Start the task',
      actorName: 'runtime-agent',
      actorRole: 'owner',
      turnIndex: 0,
      metadata: {},
      ts: turns[0]?.ts
    });
    assert.equal(turns[1]?.actorName, 'specialist');
    assert.equal(turns[1]?.actorRole, 'steerer');
    assert.deepEqual(turns[2]?.metadata, {
      nativeCli: 'codex',
      nativeResumeId: 'codex-resume-123'
    });
  } finally {
    if (previousToken === undefined) delete process.env.RELAYHISTORY_ACCESS_TOKEN;
    else process.env.RELAYHISTORY_ACCESS_TOKEN = previousToken;
    await close();
  }
});

test('logs relayhistory failures without throwing into the caller', async () => {
  const requests: CapturedRequest[] = [];
  const { baseUrl, close } = await captureServer(requests, 1, 503);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

  try {
    const writer = new RelayhistoryTurnWriter({
      relaySessionId: 'session-failure',
      sessionOwner: 'Danny',
      actorName: 'runtime-agent',
      relayhistoryUrl: baseUrl,
      orgId: 'org-a'
    });

    assert.doesNotThrow(() =>
      writer.writeTurn({ role: 'assistant', content: 'Main session still succeeds' })
    );
    await waitFor(() => errors.length === 1);
    assert.match(errors[0]!, /failed to write turn 0/);
    assert.match(errors[0]!, /503 Service Unavailable/);
  } finally {
    console.error = originalError;
    await close();
  }
});

async function captureServer(
  requests: CapturedRequest[],
  expectedRequests: number,
  statusCode = 200
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? '',
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    });
    response.statusCode = statusCode;
    response.end(statusCode === 200 ? '{}' : 'history unavailable');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await waitFor(() => requests.length >= expectedRequests).catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for relayhistory request');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
