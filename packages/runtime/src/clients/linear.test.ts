import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLinearClient } from './linear.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-'));
}

test('linear createIssue writes an issue draft', async () => {
  const root = await tempMount();
  try {
    const client = createLinearClient({ relayfileMountRoot: root });
    await client.createIssue({ teamId: 'team_1', title: 'Ship it', description: 'Soon' });

    const dir = path.join(root, 'linear/issues');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      teamId: 'team_1',
      title: 'Ship it',
      description: 'Soon'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linear getIssue reads a canonical issue file', async () => {
  const root = await tempMount();
  try {
    const issuePath = path.join(root, 'linear/issues/ENG-1.json');
    await mkdir(path.dirname(issuePath), { recursive: true });
    await writeFile(
      issuePath,
      JSON.stringify({ id: 'i1', identifier: 'ENG-1', title: 'Ship it', description: null, url: 'https://linear.app/i1', state: null })
    );

    const client = createLinearClient({ relayfileMountRoot: root });
    assert.equal((await client.getIssue('ENG-1')).identifier, 'ENG-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
