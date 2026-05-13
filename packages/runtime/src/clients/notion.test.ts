import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotionClient } from './notion.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'workforce-runtime-'));
}

test('notion createPage writes a database page draft', async () => {
  const root = await tempMount();
  try {
    const client = createNotionClient({ relayfileMountRoot: root });
    await client.createPage(
      { database_id: 'db_1' },
      { Name: { title: [{ text: { content: 'Digest' } }] } },
      [{ object: 'block', type: 'paragraph' }]
    );

    const dir = path.join(root, 'notion/databases/db_1/pages');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')), {
      properties: { Name: { title: [{ text: { content: 'Digest' } }] } },
      children: [{ object: 'block', type: 'paragraph' }]
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('notion createPage requires a database parent for file writeback', async () => {
  const client = createNotionClient({ relayfileMountRoot: '/tmp/unused' });
  await assert.rejects(
    () => client.createPage({}, {}, []),
    /parent\.database_id/
  );
});
