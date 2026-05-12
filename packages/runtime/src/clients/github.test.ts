import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('github getPr reads canonical metadata and diff files', async () => {
  const root = await tempMount();
  try {
    const pullDir = path.join(root, 'github/repos/acme/app/pulls/42__fix-deploy');
    await mkdir(pullDir, { recursive: true });
    await writeFile(
      path.join(pullDir, 'meta.json'),
      JSON.stringify({
        title: 'Fix deploy',
        body: 'Details',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        user: { login: 'mona' }
      })
    );
    await writeFile(path.join(pullDir, 'diff.patch'), 'diff --git a/app.ts b/app.ts\n');

    const client = createGithubClient({ relayfileMountRoot: root });
    assert.deepEqual(await client.getPr({ owner: 'acme', repo: 'app', number: 42 }), {
      title: 'Fix deploy',
      body: 'Details',
      diff: 'diff --git a/app.ts b/app.ts\n',
      head: 'feature',
      base: 'main',
      author: 'mona'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github upsertIssue finds existing canonical issue directories', async () => {
  const root = await tempMount();
  try {
    const issueDir = path.join(root, 'github/repos/acme/app/issues/7__bug');
    await mkdir(issueDir, { recursive: true });
    await writeFile(
      path.join(issueDir, 'meta.json'),
      JSON.stringify({ number: 7, title: 'Bug', html_url: 'https://github.com/acme/app/issues/7' })
    );

    const client = createGithubClient({ relayfileMountRoot: root });
    const result = await client.upsertIssue({
      owner: 'acme',
      repo: 'app',
      title: 'Bug',
      body: 'Updated details',
      matchTitle: 'Bug'
    });

    assert.deepEqual(result, {
      number: 7,
      url: 'https://github.com/acme/app/issues/7',
      created: false
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'github/repos/acme/app/issues/7.json'), 'utf8')), {
      title: 'Bug',
      body: 'Updated details'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
