import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { SlackClient } from '@relayfile/relay-helpers';
import { createDelivery } from './delivery.js';
import {
  buildSlackMentionIndex,
  formatSlackRoster,
  isSlackChannelId,
  linkSlackMentions,
  loadSlackUsers,
  requireSlackReceipt,
  resolveSlackUserId,
  type SlackUser
} from './slack.js';
import type { WorkforceCtx } from '@agentworkforce/runtime';

test('loadSlackUsers prefers the compact index and excludes bots and Slackbot', async (t) => {
  const root = await tempMount(t);
  const usersDir = path.join(root, 'slack', 'users');
  await mkdir(usersDir, { recursive: true });
  await writeJson(path.join(usersDir, '_index.json'), [
    { id: 'U1', name: 'will', title: 'Will Washburn' },
    { id: 'U2', name: 'buildbot', title: 'Build Bot', is_bot: true },
    { id: 'USLACKBOT', name: 'slackbot', title: 'Slackbot' },
    { id: 'U3', name: '', title: '' }
  ]);
  // If the index is usable, the directory fallback must not add this user.
  await writeJson(path.join(usersDir, 'U4__fallback', 'meta.json'), {
    id: 'U4',
    name: 'fallback',
    real_name: 'Fallback User'
  });

  assert.deepEqual(await loadSlackUsers({ relayfileMountRoot: root }), [
    { id: 'U1', handle: 'will', displayName: 'Will Washburn' }
  ]);
});

test('loadSlackUsers falls back to member meta records and preserves display-name priority', async (t) => {
  const root = await tempMount(t);
  const usersDir = path.join(root, 'slack', 'users');
  await writeFile(path.join(root, 'placeholder'), '');
  await writeJson(path.join(usersDir, 'U1__khaliq', 'meta.json'), {
    id: 'U1',
    name: 'khaliq',
    display_name: 'Khaliq Gant',
    real_name: 'Ignored Real Name'
  });
  await writeJson(path.join(usersDir, 'U2__will', 'meta.json'), {
    id: 'U2',
    name: 'will',
    display_name: '',
    real_name: 'Will Washburn'
  });
  await writeJson(path.join(usersDir, 'U3__bot', 'meta.json'), {
    id: 'U3',
    name: 'bot',
    is_bot: true
  });
  await writeJson(path.join(usersDir, 'USLACKBOT__slackbot', 'meta.json'), {
    id: 'USLACKBOT',
    name: 'slackbot'
  });
  await mkdir(path.join(usersDir, 'bots'), { recursive: true });
  await mkdir(path.join(usersDir, 'by-name'), { recursive: true });

  assert.deepEqual(await loadSlackUsers({ relayfileMountRoot: root }), [
    { id: 'U1', handle: 'khaliq', displayName: 'Khaliq Gant' },
    { id: 'U2', handle: 'will', displayName: 'Will Washburn' }
  ]);
});

test('loadSlackUsers reports an unavailable users directory without throwing', async (t) => {
  const root = await tempMount(t);
  const warnings: unknown[] = [];

  assert.deepEqual(
    await loadSlackUsers({ relayfileMountRoot: root, onWarning: (warning) => warnings.push(warning) }),
    []
  );
  assert.equal(warnings.length, 1);
  const warning = warnings[0] as { code: string; path: string; error: string };
  assert.equal(warning.code, 'users_directory_unavailable');
  assert.equal(warning.path, path.join(root, 'slack', 'users'));
  assert.match(warning.error, /slack\/users/);
});

test('mention index resolves exact names and only unambiguous first names', () => {
  const users: SlackUser[] = [
    { id: 'U1', handle: 'will', displayName: 'Will Washburn' },
    { id: 'U2', handle: 'khaliq', displayName: 'Khaliq Gant' },
    { id: 'U3', handle: 'willow', displayName: 'Will Example' }
  ];
  const index = buildSlackMentionIndex(users);

  assert.equal(resolveSlackUserId('@WILL', index), 'U1');
  assert.equal(resolveSlackUserId('Khaliq Gant', index), 'U2');
  assert.equal(resolveSlackUserId('khaliq', index), 'U2');
  // Two display names start with Will, so the first-name fallback is ambiguous.
  const noExactWill = buildSlackMentionIndex(users.map((user) => (
    user.id === 'U1' ? { ...user, handle: 'wwashburn' } : user
  )));
  assert.equal(resolveSlackUserId('will', noExactWill), null);
  assert.equal(resolveSlackUserId('missing', index), null);
});

test('linkSlackMentions preserves emails and existing links while reporting unresolved tokens', () => {
  const index = buildSlackMentionIndex([
    { id: 'U1', handle: 'will', displayName: 'Will Washburn' }
  ]);

  assert.deepEqual(
    linkSlackMentions('Ping @will, keep <@U1>, mail a@b.com, and ask @missing, please.', index),
    {
      text: 'Ping <@U1>, keep <@U1>, mail a@b.com, and ask @missing, please.',
      unresolved: ['missing']
    }
  );
});

test('formatSlackRoster returns sorted handle lines and skips users without handles', () => {
  assert.equal(
    formatSlackRoster([
      { id: 'U2', handle: 'will', displayName: 'Will Washburn' },
      { id: 'U1', handle: 'khaliq', displayName: 'Khaliq Gant' },
      { id: 'U3', handle: 'ada', displayName: '' },
      { id: 'U4', handle: '', displayName: 'No Handle' }
    ]),
    '@ada\n@khaliq — Khaliq Gant\n@will — Will Washburn'
  );
});

test('isSlackChannelId enforces exact Slack conversation ids', () => {
  assert.equal(isSlackChannelId('C0B991XH3L5'), true);
  assert.equal(isSlackChannelId('D12345678'), true);
  assert.equal(isSlackChannelId('G12345678'), true);
  assert.equal(isSlackChannelId('#general'), false);
  assert.equal(isSlackChannelId('C123'), false);
  assert.equal(isSlackChannelId(' c0b991xh3l5 '), false);
});

test('requireSlackReceipt returns delivered results and rejects empty timestamps', () => {
  const delivered = { channel: 'C12345678', ts: '1750000000.000100', ref: '/draft' };
  assert.equal(requireSlackReceipt(delivered), delivered);
  assert.throws(
    () => requireSlackReceipt({ channel: 'C12345678', ts: '' }),
    /Slack post to C12345678 got no writeback receipt \(silent drop\)/
  );
});

test('createDelivery uses the strict Slack receipt boundary in blocking mode', async () => {
  const slack = {
    async post(channel: string) {
      return { channel, ts: '', ref: '/slack/draft' };
    }
  } as unknown as SlackClient;
  const ctx = {
    persona: { inputs: { SLACK_CHANNEL: 'C12345678' }, inputSpecs: {} },
    log: () => {}
  } as unknown as WorkforceCtx;

  const delivery = createDelivery(ctx, { slack });
  await assert.rejects(
    () => delivery.send('hello'),
    /Slack post to C12345678 got no writeback receipt \(silent drop\)/
  );
});

async function tempMount(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workforce-delivery-slack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
