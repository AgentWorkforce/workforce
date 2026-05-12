import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDev } from './dev.js';
import type { BundleResult } from '../bundle.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-dev-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function bundle(runnerPath: string): BundleResult {
  return {
    personaCopyPath: join(runnerPath, '..', 'persona.json'),
    runnerPath,
    bundlePath: join(runnerPath, '..', 'agent.bundle.mjs'),
    packageJsonPath: join(runnerPath, '..', 'package.json'),
    sizeBytes: 1
  };
}

test('runDev streams line-buffered runtime logs and resolves done', async () => {
  await withTmpDir(async (dir) => {
    const runnerPath = join(dir, 'runner.mjs');
    await writeFile(runnerPath, "process.stdout.write('hel'); console.log('lo');", 'utf8');

    const logs: string[] = [];
    const handle = await runDev({ bundle: bundle(runnerPath), onLog: (line) => logs.push(line) });
    const result = await handle.done;

    assert.ok(handle.pid > 0);
    assert.deepEqual(logs, ['[runtime] hello']);
    assert.deepEqual(result, { code: 0, signal: null });
  });
});

test('runDev stop terminates a long-lived runner', async () => {
  await withTmpDir(async (dir) => {
    const runnerPath = join(dir, 'runner.mjs');
    await writeFile(runnerPath, "setInterval(() => console.log('tick'), 1000);", 'utf8');

    const handle = await runDev({ bundle: bundle(runnerPath), onLog: () => undefined });
    await handle.stop();
    const result = await handle.done;

    assert.equal(result.signal, 'SIGTERM');
  });
});
