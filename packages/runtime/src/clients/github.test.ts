import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGithubClient } from './github.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-github-'));
}

test('github.comment writes a draft comment file under issues/<n>/comments/', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.comment({ owner: 'o', repo: 'r', number: 2 }, 'hello');

    const dir = path.join(root, 'github/repos/o/r/issues/2/comments');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      body: 'hello'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.createIssue writes a draft issue file under issues/', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.createIssue({
      owner: 'o',
      repo: 'r',
      title: 'Track A',
      body: 'do the thing',
      labels: ['digest']
    });

    const dir = path.join(root, 'github/repos/o/r/issues');
    const files = await readdir(dir);
    const drafts = files.filter((name) => name.endsWith('.json'));
    assert.equal(drafts.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, drafts[0] ?? ''), 'utf8')), {
      title: 'Track A',
      body: 'do the thing',
      labels: ['digest']
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.createPullRequest writes a draft pull request file under pulls/', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.createPullRequest({
      owner: 'o',
      repo: 'r',
      title: 'Essay: Draft',
      body: 'Adds the essay.',
      head: 'essay/page-1',
      base: 'main',
      files: { 'output/page-1.md': '# Essay' }
    });

    const dir = path.join(root, 'github/repos/o/r/pulls');
    const files = await readdir(dir);
    const drafts = files.filter((name) => name.endsWith('.json'));
    assert.equal(drafts.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, drafts[0] ?? ''), 'utf8')), {
      title: 'Essay: Draft',
      body: 'Adds the essay.',
      head: 'essay/page-1',
      base: 'main',
      files: { 'output/page-1.md': '# Essay' }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.upsertIssue updates an existing flat issue match', async () => {
  const root = await tempMount();
  try {
    const issueDir = path.join(root, 'github/repos/o/r/issues');
    await mkdir(issueDir, { recursive: true });
    await writeFile(
      path.join(issueDir, '7.json'),
      JSON.stringify({
        number: 7,
        state: 'open',
        title: 'Weekly digest — 2026-W20',
        html_url: 'https://github.com/o/r/issues/7'
      })
    );

    const client = createGithubClient({ relayfileMountRoot: root });
    const result = await client.upsertIssue({
      owner: 'o',
      repo: 'r',
      title: 'Weekly digest — 2026-W20',
      body: 'refreshed',
      matchTitle: 'Weekly digest — 2026-W20'
    });
    assert.equal(result.created, false);
    assert.equal(result.number, 7);
    // Update wrote the canonical issue file in place.
    const updated = JSON.parse(await readFile(path.join(issueDir, '7.json'), 'utf8'));
    assert.equal(updated.body, 'refreshed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.upsertIssue ignores a closed issue title match', async () => {
  const root = await tempMount();
  try {
    const issueDir = path.join(root, 'github/repos/o/r/issues');
    await mkdir(issueDir, { recursive: true });
    await writeFile(
      path.join(issueDir, '7.json'),
      JSON.stringify({
        number: 7,
        state: 'closed',
        title: 'Weekly digest — 2026-W20',
        html_url: 'https://github.com/o/r/issues/7'
      })
    );

    const client = createGithubClient({ relayfileMountRoot: root });
    const result = await client.upsertIssue({
      owner: 'o',
      repo: 'r',
      title: 'Weekly digest — 2026-W20',
      body: 'fresh open issue',
      matchTitle: 'Weekly digest — 2026-W20'
    });
    assert.equal(result.created, true);

    const files = await readdir(issueDir);
    const drafts = files.filter((name) => name.endsWith('.json') && name !== '7.json');
    assert.equal(drafts.length, 1);
    const closed = JSON.parse(await readFile(path.join(issueDir, '7.json'), 'utf8'));
    assert.equal(closed.body, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.upsertIssue creates a draft when no open match exists', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    const result = await client.upsertIssue({
      owner: 'o',
      repo: 'r',
      title: 'fresh',
      body: 'b',
      matchTitle: 'fresh'
    });
    assert.equal(result.created, true);

    const dir = path.join(root, 'github/repos/o/r/issues');
    const drafts = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    assert.equal(drafts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.getPr reads meta + diff from canonical paths', async () => {
  const root = await tempMount();
  try {
    const pullRoot = path.join(root, 'github/repos/o/r/pulls/42');
    await mkdir(pullRoot, { recursive: true });
    await writeFile(
      path.join(pullRoot, 'meta.json'),
      JSON.stringify({
        title: 'Add deploy v1',
        body: 'ships it',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        user: { login: 'kgnt' }
      })
    );
    await writeFile(path.join(pullRoot, 'diff.patch'), 'diff --git a/x b/x\n');

    const client = createGithubClient({ relayfileMountRoot: root });
    const pr = await client.getPr({ owner: 'o', repo: 'r', number: 42 });
    assert.equal(pr.title, 'Add deploy v1');
    assert.equal(pr.head, 'feature');
    assert.equal(pr.base, 'main');
    assert.equal(pr.author, 'kgnt');
    assert.match(pr.diff, /^diff --git/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.getPr reads a flat canonical pull request file', async () => {
  const root = await tempMount();
  try {
    const pullDir = path.join(root, 'github/repos/o/r/pulls');
    await mkdir(pullDir, { recursive: true });
    await writeFile(
      path.join(pullDir, '42.json'),
      JSON.stringify({
        title: 'Add deploy v1',
        body: 'ships it',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        user: { login: 'kgnt' },
        diff: 'diff --git a/x b/x\n'
      })
    );

    const client = createGithubClient({ relayfileMountRoot: root });
    const pr = await client.getPr({ owner: 'o', repo: 'r', number: 42 });
    assert.equal(pr.title, 'Add deploy v1');
    assert.equal(pr.head, 'feature');
    assert.equal(pr.base, 'main');
    assert.equal(pr.author, 'kgnt');
    assert.match(pr.diff, /^diff --git/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.postReview writes a review draft under pulls/<n>/reviews/', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    await client.postReview(
      { owner: 'o', repo: 'r', number: 42 },
      {
        body: 'lgtm',
        event: 'APPROVE',
        comments: [{ path: 'src/x.ts', line: 7, body: 'nit' }]
      }
    );

    const reviewsDir = path.join(root, 'github/repos/o/r/pulls/42/reviews');
    const drafts = (await readdir(reviewsDir)).filter((name) => name.endsWith('.json'));
    assert.equal(drafts.length, 1);
    const payload = JSON.parse(await readFile(path.join(reviewsDir, drafts[0] ?? ''), 'utf8'));
    assert.equal(payload.event, 'APPROVE');
    assert.equal(payload.comments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('github.postReview accepts COMMENT/APPROVE/REQUEST_CHANGES events', async () => {
  const root = await tempMount();
  try {
    const client = createGithubClient({ relayfileMountRoot: root });
    for (const event of ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const) {
      await client.postReview({ owner: 'o', repo: 'r', number: event === 'COMMENT' ? 1 : event === 'APPROVE' ? 2 : 3 }, {
        body: event.toLowerCase(),
        event
      });
    }
    // Three review drafts landed across three different PR review dirs.
    const dirs = await readdir(path.join(root, 'github/repos/o/r/pulls'));
    assert.deepEqual(dirs.sort(), ['1', '2', '3']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
