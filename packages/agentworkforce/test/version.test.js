import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const binPath = fileURLToPath(new URL('../bin/agentworkforce.js', import.meta.url));

async function runAgentworkforce(args) {
  const child = spawn(process.execPath, [binPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout += buf.toString();
  });
  child.stderr.on('data', (buf) => {
    stderr += buf.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', resolve);
  });
  return { exitCode, stdout, stderr };
}

test('agentworkforce --version prints the wrapper package version', async () => {
  const { exitCode, stdout, stderr } = await runAgentworkforce(['--version']);
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, `${pkg.version}\n`);
});
