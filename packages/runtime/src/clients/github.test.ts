import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGithubClient } from './github.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-'));
}

test('github createIssue writes a Relayfile issue draft', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.createIssue({
      owner: 'acme',
      repo: 'app',
      title: 'Bug',
      body: 'Details',
      labels: ['triage']
    });

    const dir = path.join(root, 'github/repos/acme/app/issues');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? '', /^create issue .+\.json$/);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      title: 'Bug',
      body: 'Details',
      labels: ['triage']
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github comment writes an issue comment draft', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.comment({ owner: 'acme', repo: 'app', number: 42 }, 'Looks good.');

    const dir = path.join(root, 'github/repos/acme/app/issues/42/comments');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      body: 'Looks good.'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
