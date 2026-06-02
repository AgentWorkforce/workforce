import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WRITEBACK_PATH_CATALOG } from '@relayfile/adapter-core/writeback-paths';
import { githubClient, linearClient, relayClient, slackClient } from './index.js';

/** Fire-and-forget client bound to a throwaway mount; no writeback worker runs. */
async function mount(): Promise<{ root: string; opts: { relayfileMountRoot: string; writebackTimeoutMs: number } }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-helpers-'));
  return { root, opts: { relayfileMountRoot: root, writebackTimeoutMs: 0 } };
}

async function onlyJsonIn(dir: string): Promise<{ name: string; body: unknown }> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.json'));
  assert.equal(entries.length, 1, `expected one draft in ${dir}, saw ${entries.join(', ') || 'none'}`);
  return { name: entries[0], body: JSON.parse(await readFile(path.join(dir, entries[0]), 'utf8')) };
}

test('relayClient.path resolves catalog paths and write drops a collection draft', async () => {
  const { root, opts } = await mount();
  const linear = relayClient('linear', opts);
  assert.equal(linear.path('comments', { issueId: 'ISS-1' }), '/linear/issues/ISS-1/comments');

  await linear.write('comments', { issueId: 'ISS-1' }, { body: 'hi' });
  const draft = await onlyJsonIn(path.join(root, 'linear/issues/ISS-1/comments'));
  assert.deepEqual(draft.body, { body: 'hi' });
});

test('relayClient.write writes item (.json) resources to the exact path', async () => {
  const { root, opts } = await mount();
  const gh = relayClient('github', opts);
  // `merge` resolves to `…/merge.json` — an item path, written directly (no draft).
  await gh.write('merge', { owner: 'o', repo: 'r', pullNumber: 7 }, { merge_method: 'squash' });
  const body = JSON.parse(await readFile(path.join(root, 'github/repos/o/r/pulls/7/merge.json'), 'utf8'));
  assert.deepEqual(body, { merge_method: 'squash' });
});

test('relayClient.read / list operate over the catalog paths', async () => {
  const { root, opts } = await mount();
  await mkdir(path.join(root, 'linear/issues'), { recursive: true });
  await writeFile(path.join(root, 'linear/issues/ISS-9.json'), JSON.stringify({ id: 'ISS-9', title: 't' }));
  const linear = relayClient('linear', opts);
  const listed = await linear.list<{ id: string }>('issues');
  assert.deepEqual(listed.map((i) => i.id), ['ISS-9']);
});

test('linearClient recovers comment / createIssue / getIssue ergonomics', async () => {
  const { root, opts } = await mount();
  await mkdir(path.join(root, 'linear/issues'), { recursive: true });
  await writeFile(path.join(root, 'linear/issues/ISS-1.json'), JSON.stringify({ id: 'ISS-1', title: 'Fix' }));

  const linear = linearClient(opts);
  const issue = await linear.getIssue<{ title: string }>('ISS-1');
  assert.equal(issue.title, 'Fix');

  await linear.comment('ISS-1', ':rocket: done');
  const comment = await onlyJsonIn(path.join(root, 'linear/issues/ISS-1/comments'));
  assert.deepEqual(comment.body, { body: ':rocket: done' });

  // Fresh mount so the create draft is the only file in /linear/issues.
  const fresh = await mount();
  await linearClient(fresh.opts).createIssue({ teamId: 'T', title: 'New' });
  const created = await onlyJsonIn(path.join(fresh.root, 'linear/issues'));
  assert.deepEqual(created.body, { teamId: 'T', title: 'New' });
});

test('githubClient.comment and slackClient.post target the canonical paths', async () => {
  const { root, opts } = await mount();
  await githubClient(opts).comment({ owner: 'AgentWorkforce', repo: 'cloud', number: 1643 }, 'hello');
  const ghComment = await onlyJsonIn(path.join(root, 'github/repos/AgentWorkforce/cloud/issues/1643/comments'));
  assert.deepEqual(ghComment.body, { body: 'hello' });

  await slackClient(opts).post('C123', 'shipped');
  const msg = await onlyJsonIn(path.join(root, 'slack/channels/C123/messages'));
  assert.deepEqual(msg.body, { text: 'shipped' });
});

test('relayClient covers every provider in the catalog', () => {
  const providers = Object.keys(WRITEBACK_PATH_CATALOG);
  assert.ok(providers.length >= 29, `expected >=29 providers, saw ${providers.length}`);
  for (const provider of providers) {
    const client = relayClient(provider as keyof typeof WRITEBACK_PATH_CATALOG);
    const [resource, variants] = Object.entries(WRITEBACK_PATH_CATALOG[provider as keyof typeof WRITEBACK_PATH_CATALOG])[0];
    // Build params from the first variant's placeholders so path() resolves.
    const params = Object.fromEntries((variants[0].params as readonly string[]).map((name) => [name, 'x']));
    assert.ok(client.path(resource as never, params).startsWith(`/${provider}`));
  }
});
