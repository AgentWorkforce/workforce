import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    const client = createSlackClient({ relayfileMountRoot: root });
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

test('slack dm writes a user direct-message draft', async () => {
  const root = await tempMount();
  try {
    const client = createSlackClient({ relayfileMountRoot: root });
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
  const client = createSlackClient({ relayfileMountRoot: '/tmp/unused' });
  await assert.rejects(
    () => client.reply('missing-ts', 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
});

test('slack reply rejects malformed object thread refs', async () => {
  const client = createSlackClient({ relayfileMountRoot: '/tmp/unused' });
  await assert.rejects(
    () => client.reply({ channel: '', ts: '123.456' }, 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
  await assert.rejects(
    () => client.reply({ channel: 'C123', ts: '' }, 'hello'),
    (error) => error instanceof WorkforceIntegrationError && error.provider === 'slack'
  );
});
