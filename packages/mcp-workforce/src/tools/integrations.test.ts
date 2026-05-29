import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchIntegration, _resetIntegrationCache } from './integrations.js';
import type { WorkforceMcpConfig } from '../config.js';

async function tempMount(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcp-workforce-int-'));
}

function config(over: Partial<WorkforceMcpConfig> = {}): WorkforceMcpConfig {
  return {
    workspaceId: 'ws-demo',
    cloudUrl: 'https://cloud.example.com',
    writebackTimeoutMs: 0,
    ...over
  };
}

test('dispatchIntegration rejects malformed tool names', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () => dispatchIntegration('integration.github', {}, { config: config() }),
    /must be "integration\.<provider>\.<method>"/
  );
  await assert.rejects(
    () => dispatchIntegration('memory.save', {}, { config: config() }),
    /must be "integration\.<provider>\.<method>"/
  );
});

test('dispatchIntegration rejects unwired providers', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () => dispatchIntegration('integration.linear.createIssue', {}, { config: config() }),
    /integration provider "linear" is not wired/
  );
});

test('dispatchIntegration rejects when RELAYFILE_MOUNT_ROOT is missing', async () => {
  _resetIntegrationCache();
  await assert.rejects(
    () =>
      dispatchIntegration(
        'integration.github.comment',
        { target: { owner: 'o', repo: 'r', number: 1 }, body: 'x' },
        { config: config() }
      ),
    /RELAYFILE_MOUNT_ROOT is required/
  );
});

test('dispatchIntegration writes a github comment draft under the Relayfile mount', async () => {
  _resetIntegrationCache();
  const mount = await tempMount();
  try {
    const result = (await dispatchIntegration(
      'integration.github.comment',
      { target: { owner: 'o', repo: 'r', number: 1 }, body: 'hello' },
      { config: config({ relayfileMountRoot: mount }) }
    )) as { id: string; url: string };

    // The Relayfile writeback worker would populate the receipt; with
    // writebackTimeoutMs=0 the client returns immediately and the
    // draft path is what we'd expect to see on disk.
    assert.match(result.url, /^\/github\/repos\/o\/r\/issues\/1\/comments\//);
    const commentsDir = path.join(mount, 'github/repos/o/r/issues/1/comments');
    const drafts = await readdir(commentsDir);
    assert.equal(drafts.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(commentsDir, drafts[0] ?? ''), 'utf8')), {
      body: 'hello'
    });
  } finally {
    await rm(mount, { recursive: true, force: true });
    _resetIntegrationCache();
  }
});

test('dispatchIntegration reads github PR metadata and diff from nested canonical files', async () => {
  _resetIntegrationCache();
  const mount = await tempMount();
  try {
    const pullRoot = path.join(mount, 'github/repos/o/r/pulls/42__feature');
    await mkdir(pullRoot, { recursive: true });
    await writeFile(
      path.join(pullRoot, 'meta.json'),
      JSON.stringify({
        title: 'Add deploy v1',
        body: 'ships it',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        user: { login: 'kgnt' }
      }),
      'utf8'
    );
    await writeFile(path.join(pullRoot, 'diff.patch'), 'diff --git a/x b/x\n', 'utf8');

    const result = (await dispatchIntegration(
      'integration.github.getPr',
      { target: { owner: 'o', repo: 'r', number: 42 } },
      { config: config({ relayfileMountRoot: mount }) }
    )) as Record<string, unknown>;

    assert.equal(result.title, 'Add deploy v1');
    assert.equal(result.head, 'feature');
    assert.equal(result.base, 'main');
    assert.equal(result.author, 'kgnt');
    assert.equal(result.diff, 'diff --git a/x b/x\n');
  } finally {
    await rm(mount, { recursive: true, force: true });
    _resetIntegrationCache();
  }
});

test('dispatchIntegration validates github.postReview event enum', async () => {
  _resetIntegrationCache();
  const mount = await tempMount();
  try {
    await assert.rejects(
      () =>
        dispatchIntegration(
          'integration.github.postReview',
          {
            target: { owner: 'o', repo: 'r', number: 1 },
            review: { body: 'lgtm', event: 'WAVE' }
          },
          { config: config({ relayfileMountRoot: mount }) }
        ),
      /review\.event must be one of/
    );
  } finally {
    await rm(mount, { recursive: true, force: true });
    _resetIntegrationCache();
  }
});

test('dispatchIntegration surfaces missing required fields with field-pointed errors', async () => {
  _resetIntegrationCache();
  const mount = await tempMount();
  try {
    await assert.rejects(
      () =>
        dispatchIntegration(
          'integration.github.createIssue',
          { owner: 'o', repo: '', title: 't', body: 'b' },
          { config: config({ relayfileMountRoot: mount }) }
        ),
      /repo: must be a non-empty string/
    );
  } finally {
    await rm(mount, { recursive: true, force: true });
    _resetIntegrationCache();
  }
});
