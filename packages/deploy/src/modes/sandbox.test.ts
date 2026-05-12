import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandbox, setDaytonaFactoryForTest } from './sandbox.js';
import type { BundleResult } from '../bundle.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-sandbox-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function bundle(dir: string): BundleResult {
  return {
    personaCopyPath: join(dir, 'persona.json'),
    runnerPath: join(dir, 'runner.mjs'),
    bundlePath: join(dir, 'agent.bundle.mjs'),
    packageJsonPath: join(dir, 'package.json'),
    sizeBytes: 1
  };
}

test('runSandbox creates a Daytona sandbox, uploads the bundle, executes runner, and deletes on stop', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'runner.mjs'), 'console.log("hello")', 'utf8');
    await writeFile(join(dir, 'agent.bundle.mjs'), 'export {}', 'utf8');
    await writeFile(join(dir, 'persona.json'), '{}', 'utf8');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}', 'utf8');

    const calls: string[] = [];
    const sandbox = {
      id: 'sandbox-1',
      fs: {
        uploadFiles: async (files: Array<{ source: string; destination: string }>) => {
          calls.push(`upload:${files.map((file) => file.destination).sort().join(',')}`);
        }
      },
      process: {
        createSession: async (sessionId: string) => {
          calls.push(`createSession:${sessionId.startsWith('workforce-')}`);
        },
        executeSessionCommand: async (
          _sessionId: string,
          req: { command: string; runAsync?: boolean },
          timeout?: number
        ) => {
          calls.push(`sessionCommand:${req.command}:${req.runAsync}:${timeout}`);
          return { cmdId: 'cmd-1' };
        },
        getSessionCommandLogs: async (
          _sessionId: string,
          _commandId: string,
          onStdout: (chunk: string) => void
        ) => {
          calls.push('logs');
          onStdout('hel');
          onStdout('lo\nwor');
          onStdout('ld');
        },
        getSessionCommand: async () => {
          calls.push('commandStatus');
          return { exitCode: 0 };
        },
        executeCommand: async () => {
          calls.push('fallback');
          return { exitCode: 1, result: '' };
        }
      }
    };
    const restore = setDaytonaFactoryForTest((config) => {
      calls.push(`client:${config.apiKey}`);
      return {
        create: async (params) => {
          calls.push(`create:${params.language}:${params.envVars?.FOO}`);
          return sandbox;
        },
        delete: async (target) => {
          calls.push(`delete:${target.id}`);
        }
      };
    });

    try {
      const logs: string[] = [];
      const handle = await runSandbox({
        bundle: bundle(dir),
        sandboxConfig: { timeoutSeconds: 42 },
        env: { FOO: 'bar' },
        onLog: (line) => logs.push(line),
        daytona: { apiKey: 'key' }
      });
      const result = await handle.done;
      await handle.stop();

      assert.equal(handle.sandboxId, 'sandbox-1');
      assert.deepEqual(result, { code: 0 });
      assert.deepEqual(logs, ['[runtime] hello', '[runtime] world']);
      assert.deepEqual(calls, [
        'client:key',
        'create:typescript:bar',
        'upload:/home/user/project/agent.bundle.mjs,/home/user/project/package.json,/home/user/project/persona.json,/home/user/project/runner.mjs',
        'createSession:true',
        'sessionCommand:cd /home/user/project && node runner.mjs:true:42',
        'logs',
        'commandStatus',
        'delete:sandbox-1'
      ]);
    } finally {
      restore();
    }
  });
});

test('runSandbox propagates Daytona create errors', async () => {
  const restore = setDaytonaFactoryForTest(() => ({
    create: async () => {
      throw new Error('daytona unavailable');
    },
    delete: async () => undefined
  }));

  try {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, 'runner.mjs'), '', 'utf8');
      await assert.rejects(
        runSandbox({
          bundle: bundle(dir),
          sandboxConfig: true,
          daytona: { apiKey: 'key' }
        }),
        /daytona unavailable/
      );
    });
  } finally {
    restore();
  }
});

test('runSandbox deletes a created sandbox when bundle upload fails', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'runner.mjs'), '', 'utf8');
    const calls: string[] = [];
    const sandbox = {
      id: 'sandbox-upload-failed',
      fs: {
        uploadFiles: async () => {
          calls.push('upload');
          throw new Error('upload failed');
        }
      },
      process: {
        executeCommand: async () => ({ exitCode: 0, result: '' })
      }
    };
    const restore = setDaytonaFactoryForTest(() => ({
      create: async () => {
        calls.push('create');
        return sandbox;
      },
      delete: async (target) => {
        calls.push(`delete:${target.id}`);
      }
    }));

    try {
      await assert.rejects(
        runSandbox({
          bundle: bundle(dir),
          sandboxConfig: true,
          daytona: { apiKey: 'key' }
        }),
        /upload failed/
      );
      assert.deepEqual(calls, ['create', 'upload', 'delete:sandbox-upload-failed']);
    } finally {
      restore();
    }
  });
});
