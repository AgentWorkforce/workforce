import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectHarness } from './detect.js';

test('detectHarness probes a Windows cursor-agent.cmd shim through ComSpec', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw detect cursor win-'));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  const previousComSpec = process.env.ComSpec;

  try {
    // The shim only needs to exist for PATH discovery. If detectHarness tries
    // to execute it directly, the test fails; the fake ComSpec is the only
    // executable that reports a successful version probe.
    writeFileSync(join(root, 'cursor-agent.cmd'), '@exit /b 99\r\n', 'utf8');
    const fakeComSpec = join(root, 'fake-cmd');
    const capturedArgs = join(root, 'comspec-args.json');
    writeFileSync(
      fakeComSpec,
      `#!${process.execPath}\n` +
        `require('node:fs').writeFileSync(${JSON.stringify(capturedArgs)}, JSON.stringify(process.argv.slice(2)));\n` +
        `process.stdout.write('cursor-agent 1.2.3\\n');\n`,
      'utf8'
    );
    chmodSync(fakeComSpec, 0o755);

    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'win32'
    });
    process.env.PATH = root;
    process.env.PATHEXT = '.cmd';
    process.env.ComSpec = fakeComSpec;

    const resolvedPath = join(root, 'cursor-agent.cmd');
    assert.deepEqual(detectHarness('cursor'), {
      harness: 'cursor',
      available: true,
      path: resolvedPath,
      version: 'cursor-agent 1.2.3'
    });
    assert.deepEqual(JSON.parse(readFileSync(capturedArgs, 'utf8')), [
      '/d',
      '/s',
      '/c',
      `"${resolvedPath}" --version`
    ]);
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathExt;
    if (previousComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previousComSpec;
    rmSync(root, { recursive: true, force: true });
  }
});
