import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkforceIntegrationError } from '../errors.js';
import { createSlackClient } from './slack.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-'));
}

test('slack post writes a channel message draft', async () => {
  const root = await tempMount();
  try {
    const client = createSlackClient({ relayfileMountRoot: root, writebackTimeoutMs: 0 });
    await client.post('C123', 'hello');

    const dir = path.join(root, 'slack/channels/C123/messages');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      text: 'hello'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('slack post waits for the writeback receipt by default', async () => {
  const root = await tempMount();
  const dir = path.join(root, 'slack/channels/C123/messages');
  let timer: NodeJS.Timeout | undefined;
  try {
    const client = createSlackClient({ relayfileMountRoot: root, writebackPollMs: 10 });
    timer = setInterval(() => {
      void readdir(dir)
        .then(async (files) => {
          const file = files.find((name) => name.endsWith('.json'));
          if (!file) return;
          await writeFile(
            path.join(dir, file),
            JSON.stringify({ created: '1716490000.123456', url: 'https://slack.example/C123/p1716490000123456' }),
            'utf8'
          );
          if (timer) clearInterval(timer);
        })
        .catch(() => undefined);
    }, 10);

    const result = await client.post('C123', 'hello');
    assert.equal(result.ts, '1716490000.123456');
  } finally {
    if (timer) clearInterval(timer);
    await rm(root, { recursive: true, force: true });
  }
});

test('slack dm writes a user direct-message draft', async () => {
  const root = await tempMount();
  try {
    const client = createSlackClient({ relayfileMountRoot: root, writebackTimeoutMs: 0 });
    await client.dm('U123', 'ping');

    const dir = path.join(root, 'slack/users/U123/messages');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      text: 'ping'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('slack reply rejects malformed string thread refs', async () => {
  const client = createSlackClient({ relayfileMountRoot: '/tmp/unused', writebackTimeoutMs: 0 });
  await assert.rejects(
    () => client.reply('missing-ts', 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
});

test('slack reply rejects malformed object thread refs', async () => {
  const client = createSlackClient({ relayfileMountRoot: '/tmp/unused', writebackTimeoutMs: 0 });
  await assert.rejects(
    () => client.reply({ channel: '', ts: '123.456' }, 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
  await assert.rejects(
    () => client.reply({ channel: 'C123', ts: '' }, 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
});
