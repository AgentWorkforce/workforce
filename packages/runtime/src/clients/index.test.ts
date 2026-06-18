import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WorkforceIntegrationError,
  WritebackError,
  normalizeWritebackStatus,
  writeJsonFile
} from './index.js';

test('writeJsonFile returns successful writes with receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workforce-writeback-ok-'));
  const relayPath = '/slack/channels/C123/messages/msg.json';
  const absolutePath = path.join(root, relayPath.slice(1));

  const pending = writeJsonFile(
    { relayfileMountRoot: root, writebackTimeoutMs: 1_000, writebackPollMs: 10 },
    'slack',
    'postMessage',
    relayPath,
    { text: 'hello' }
  );

  await waitForDraft(absolutePath);
  await writeFile(
    absolutePath,
    `${JSON.stringify({ created: '2026-06-18T18:00:00.000Z', id: 'msg-1', path: relayPath })}\n`,
    'utf8'
  );

  const result = await pending;
  assert.equal(result.path, relayPath);
  assert.equal(result.receipt?.id, 'msg-1');
  assert.equal(normalizeWritebackStatus(result).state, 'succeeded');
});

test('writeJsonFile treats missing receipts as first-class writeback errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workforce-writeback-no-receipt-'));

  await assert.rejects(
    () =>
      writeJsonFile(
        { relayfileMountRoot: root, writebackTimeoutMs: 1, writebackPollMs: 1 },
        'slack',
        'postMessage',
        '/slack/channels/C123/messages/msg.json',
        { text: 'hello' }
      ),
    (error: unknown) => {
      assert(error instanceof WritebackError);
      assert(error instanceof WorkforceIntegrationError);
      assert.equal((error as { state?: unknown }).state, 'no_receipt');
      assert.equal((error as { path?: unknown }).path, '/slack/channels/C123/messages/msg.json');
      return true;
    }
  );
});

test('writeJsonFile preserves explicit fire-and-forget writebacks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'workforce-writeback-fire-and-forget-'));
  const relayPath = '/slack/channels/C123/messages/msg.json';

  const result = await writeJsonFile(
    { relayfileMountRoot: root, writebackTimeoutMs: 0 },
    'slack',
    'postMessage',
    relayPath,
    { text: 'hello' }
  );

  assert.equal(result.path, relayPath);
  assert.equal(result.receipt, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, relayPath.slice(1)), 'utf8')), {
    text: 'hello'
  });
});

async function waitForDraft(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + 1_000;
  do {
    try {
      await readFile(filePath, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } while (Date.now() < deadline);
  throw new Error(`draft was not written: ${filePath}`);
}
