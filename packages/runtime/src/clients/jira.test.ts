import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJiraClient } from './jira.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-'));
}

test('jira createIssue writes a Jira issue draft', async () => {
  const root = await tempMount();
  try {
    const client = createJiraClient({ relayfileMountRoot: root });
    await client.createIssue({
      cloudId: 'cloud_1',
      fields: { project: { key: 'ENG' }, summary: 'Ship it', issuetype: { name: 'Task' } }
    });

    const dir = path.join(root, 'jira/issues');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      cloudId: 'cloud_1',
      fields: { project: { key: 'ENG' }, summary: 'Ship it', issuetype: { name: 'Task' } }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jira transition writes an issue transition draft', async () => {
  const root = await tempMount();
  try {
    const client = createJiraClient({ relayfileMountRoot: root });
    await client.transition({ cloudId: 'cloud_1', issueIdOrKey: 'ENG-1' }, '31');

    const dir = path.join(root, 'jira/issues/ENG-1/transitions');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      cloudId: 'cloud_1',
      transition: { id: '31' }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
