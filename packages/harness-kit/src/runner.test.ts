import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersonaSelection } from '@agentworkforce/workload-router';
import {
  buildNonInteractiveSpec,
  useRunnableSelection
} from './runner.js';

function fakeSelection(overrides: Partial<PersonaSelection> = {}): PersonaSelection {
  return {
    personaId: 'test-persona',
    tier: 'best',
    runtime: {
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'You are a test persona.',
      harnessSettings: {
        reasoning: 'high',
        timeoutSeconds: 30
      }
    },
    skills: [],
    rationale: 'test',
    ...overrides
  };
}

function writeHarness(
  dir: string,
  source: string
): string {
  const path = join(dir, 'fake-harness.js');
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

test('buildNonInteractiveSpec translates harnesses to non-interactive commands', () => {
  const claude = buildNonInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'system',
    task: 'task',
    name: 'run-name'
  });
  assert.equal(claude.bin, 'claude');
  assert.ok(claude.args.includes('--print'));
  assert.ok(claude.args.includes('--output-format'));
  assert.ok(claude.args.includes('--name'));
  assert.equal(claude.args.at(-1), 'task');

  const codex = buildNonInteractiveSpec({
    harness: 'codex',
    personaId: 'p',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'system',
    task: 'task'
  });
  assert.deepEqual(codex.args.slice(0, 4), ['exec', '-m', 'gpt-5.3-codex', '--skip-git-repo-check']);
  assert.match(String(codex.args.at(-1)), /system\n\nUser task:\ntask/);

  const opencode = buildNonInteractiveSpec({
    harness: 'opencode',
    personaId: 'p',
    model: 'opencode/gpt-5-nano',
    systemPrompt: 'system',
    task: 'task',
    workingDirectory: '/tmp/project'
  });
  assert.deepEqual(opencode.args.slice(0, 7), [
    'run',
    '--agent',
    'p',
    '--model',
    'opencode/gpt-5-nano',
    '--format',
    'default'
  ]);
  assert.ok(opencode.args.includes('--dir'));
  assert.equal(opencode.configFiles.length, 1);
});

test('useRunnableSelection spawns the harness, captures output, and passes inputs/env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runner-'));
  try {
    const harness = writeHarness(
      dir,
      `#!/usr/bin/env node
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  envValue: process.env.TEST_PERSONA_ENV
};
process.stdout.write(JSON.stringify(payload));
`
    );
    const context = useRunnableSelection(fakeSelection(), {
      commandOverrides: { codex: harness }
    });
    const progress: string[] = [];
    const result = await context.sendMessage('write a workflow', {
      workingDirectory: dir,
      inputs: { answer: 42 },
      env: { TEST_PERSONA_ENV: 'from-env' },
      onProgress: (chunk) => progress.push(chunk.text)
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(progress.join(''), result.output);
    const payload = JSON.parse(result.output);
    assert.equal(payload.cwd, realpathSync(dir));
    assert.equal(payload.envValue, 'from-env');
    assert.equal(payload.argv[0], 'exec');
    assert.match(payload.argv.at(-1), /write a workflow/);
    assert.match(payload.argv.at(-1), /"answer": 42/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('useRunnableSelection reports non-zero harness exits as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runner-fail-'));
  try {
    const harness = writeHarness(
      dir,
      `#!/usr/bin/env node
process.stderr.write('boom');
process.exit(7);
`
    );
    const context = useRunnableSelection(fakeSelection(), {
      commandOverrides: { codex: harness }
    });
    const result = await context.sendMessage('task', { workingDirectory: dir });

    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'boom');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('useRunnableSelection materializes and removes opencode config files around the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runner-opencode-'));
  try {
    const harness = writeHarness(
      dir,
      `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write(fs.readFileSync('opencode.json', 'utf8'));
`
    );
    const context = useRunnableSelection(
      fakeSelection({
        runtime: {
          harness: 'opencode',
          model: 'opencode/gpt-5-nano',
          systemPrompt: 'You are an opencode persona.',
          harnessSettings: {
            reasoning: 'medium',
            timeoutSeconds: 30
          }
        }
      }),
      { commandOverrides: { opencode: harness } }
    );
    const result = await context.sendMessage('task', { workingDirectory: dir });

    assert.equal(result.status, 'completed');
    const config = JSON.parse(result.output);
    assert.equal(config.agent['test-persona'].prompt, 'You are an opencode persona.');
    assert.throws(() => readFileSync(join(dir, 'opencode.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
