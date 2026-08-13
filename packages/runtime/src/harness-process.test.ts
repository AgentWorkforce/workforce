import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnAndCapture, spawnNonInteractiveAndCapture } from './harness-process.js';

const cwd = process.cwd();
const env = process.env;

test('spawnAndCapture round-trips a prompt larger than a pipe buffer through stdin', async () => {
  const canary = 'STDIN_CANARY_2f713bb9';
  const prompt = `${canary}\n${'x'.repeat(200_000)}`;
  const result = await spawnAndCapture({
    bin: process.execPath,
    args: [
      '-e',
      "process.stdin.setEncoding('utf8');let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>process.stdout.write(body));"
    ],
    cwd,
    env,
    stdin: prompt
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.output.length, prompt.length);
  assert.ok(result.output.startsWith(canary));
  assert.equal(result.output, prompt);
});

test('spawnNonInteractiveAndCapture writes and removes a prompt file when the child fails', async () => {
  const prompt = `FILE_CANARY_47766e8f\n${'y'.repeat(200_000)}`;
  const script = [
    "const fs=require('node:fs')",
    "const i=process.argv.indexOf('--prompt-file')",
    'const file=process.argv[i+1]',
    "const body=fs.readFileSync(file,'utf8')",
    'process.stdout.write(JSON.stringify({file,body}),()=>process.exit(23))'
  ].join(';');
  const result = await spawnNonInteractiveAndCapture({
    bin: process.execPath,
    args: ['-e', script, '--'],
    cwd,
    env,
    prompt: { mode: 'file', contents: prompt, flag: '--prompt-file' }
  });
  const observed = JSON.parse(result.output) as { file: string; body: string };

  assert.equal(result.exitCode, 23);
  assert.equal(observed.body, prompt);
  assert.equal(existsSync(observed.file), false);
});

test('spawnAndCapture turns an early-close stdin error into a loud failure', async () => {
  const result = await spawnAndCapture({
    bin: process.execPath,
    args: ['-e', "require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),50)"],
    cwd,
    env,
    stdin: 'z'.repeat(2_000_000)
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /failed to deliver prompt via stdin/);
});
