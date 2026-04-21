import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEAN_IGNORED_PATTERNS,
  SKILL_INSTALL_IGNORED_PATTERNS,
  decideCleanMode,
  parseAgentArgs,
  resolveSystemPromptPlaceholders
} from './cli.js';

// The conflict-detection path inside parseAgentArgs uses the module-local
// `die()` helper, which calls process.exit(1) after writing to stderr. Tests
// trap both so we can assert on the emitted error text without killing the
// test runner.
interface ExitTrap {
  exits: number[];
  stderr: string;
  stdout: string;
  restore: () => void;
}

function trapExit(): ExitTrap {
  const trap: ExitTrap = {
    exits: [],
    stderr: '',
    stdout: '',
    restore: () => {
      /* replaced below */
    }
  };

  const origExit = process.exit;
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);

  const fakeExit = ((code?: number) => {
    trap.exits.push(code ?? 0);
    throw new Error(`__exit_trap__:${code ?? 0}`);
  }) as typeof process.exit;

  process.exit = fakeExit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    trap.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    trap.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  trap.restore = () => {
    process.exit = origExit;
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  };
  return trap;
}

test('parseAgentArgs: --clean sets flag and preserves positional selector', () => {
  const { flags, positional } = parseAgentArgs(['--clean', 'posthog@best']);
  assert.equal(flags.clean, true);
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['posthog@best']);
});

test('parseAgentArgs: --clean accepts a task after the selector', () => {
  const { flags, positional } = parseAgentArgs([
    '--clean',
    'review@best-value',
    'look at the diff'
  ]);
  assert.equal(flags.clean, true);
  assert.deepEqual(positional, ['review@best-value', 'look at the diff']);
});

test('parseAgentArgs: no flags → both false', () => {
  const { flags, positional } = parseAgentArgs(['posthog']);
  assert.equal(flags.clean, false);
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['posthog']);
});

test('parseAgentArgs: --clean + --install-in-repo rejected with clear message', () => {
  const trap = trapExit();
  try {
    assert.throws(
      () => parseAgentArgs(['--clean', '--install-in-repo', 'posthog']),
      /__exit_trap__:1/
    );
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /mutually exclusive/);
    assert.match(trap.stderr, /--install-in-repo/);
    assert.match(trap.stderr, /--clean/);
  } finally {
    trap.restore();
  }
});

test('parseAgentArgs: flag conflict rejected regardless of flag order', () => {
  const trap = trapExit();
  try {
    assert.throws(
      () => parseAgentArgs(['--install-in-repo', '--clean', 'posthog']),
      /__exit_trap__:1/
    );
    assert.match(trap.stderr, /mutually exclusive/);
  } finally {
    trap.restore();
  }
});

test('parseAgentArgs: -- stops flag parsing, positional args after are preserved', () => {
  const { flags, positional } = parseAgentArgs([
    '--clean',
    '--',
    '--install-in-repo',
    'posthog'
  ]);
  // --install-in-repo AFTER `--` is positional, not a flag, so no conflict.
  assert.equal(flags.clean, true);
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['--install-in-repo', 'posthog']);
});

test('decideCleanMode: claude + clean=false → no mount', () => {
  assert.deepEqual(decideCleanMode('claude', false), { useClean: false });
});

test('decideCleanMode: codex + clean=false → no mount', () => {
  assert.deepEqual(decideCleanMode('codex', false), { useClean: false });
});

test('decideCleanMode: opencode defaults to mount (skills would otherwise land in repo)', () => {
  // Opencode has no installRoot support in the SDK, so the mount is the only
  // way to keep `.opencode/skills/`, `.agents/skills/`, prpm.lock, etc. out
  // of the real repo. Default-on for non-in-repo runs.
  assert.deepEqual(decideCleanMode('opencode', false), { useClean: true });
  assert.deepEqual(decideCleanMode('opencode', true), { useClean: true });
});

test('decideCleanMode: opencode + --install-in-repo → no mount', () => {
  assert.deepEqual(decideCleanMode('opencode', false, true), { useClean: false });
  assert.deepEqual(decideCleanMode('opencode', true, true), { useClean: false });
});

test('decideCleanMode: claude + clean → engaged', () => {
  assert.deepEqual(decideCleanMode('claude', true), { useClean: true });
});

test('decideCleanMode: codex + clean → disengaged with warning naming harness', () => {
  const codex = decideCleanMode('codex', true);
  assert.equal(codex.useClean, false);
  assert.match(codex.warning ?? '', /claude harness/);
  assert.match(codex.warning ?? '', /codex/);
});

test('CLEAN_IGNORED_PATTERNS: covers the declared repo-level claude config files', () => {
  // Pinned order + exact set — canary for anyone accidentally shrinking the
  // hidden-from-session footprint. Expand via review, not silently.
  assert.deepEqual([...CLEAN_IGNORED_PATTERNS], [
    'CLAUDE.md',
    'CLAUDE.local.md',
    '.claude',
    '.mcp.json'
  ]);
});

test('resolveSystemPromptPlaceholders: substitutes <harness> with the active harness', () => {
  const input =
    'produce the exact install command: `npx -y prpm install <ref> --as <harness>` for prpm using the active harness';
  const out = resolveSystemPromptPlaceholders(input, 'opencode');
  assert.match(out, /--as opencode/);
  assert.ok(!out.includes('<harness>'), 'expected <harness> placeholder to be resolved');
  // Other angle-bracket placeholders (<ref>, <repo-url>, etc.) are deliberately
  // preserved — they are LLM-facing template variables.
  assert.ok(out.includes('<ref>'));
});

test('resolveSystemPromptPlaceholders: resolves every occurrence (not just the first)', () => {
  const out = resolveSystemPromptPlaceholders('<harness> then <harness> again', 'codex');
  assert.equal(out, 'codex then codex again');
});

test('resolveSystemPromptPlaceholders: leaves prompts without the placeholder untouched', () => {
  const original = 'You are a code reviewer. No placeholders here.';
  assert.equal(resolveSystemPromptPlaceholders(original, 'claude'), original);
});

test('SKILL_INSTALL_IGNORED_PATTERNS: keeps skill-install artifacts out of the real repo', () => {
  // Pinned — non-claude sessions rely on these to prevent `.opencode/skills/`,
  // `.agents/skills/`, and skill.sh per-provider symlink farms from being
  // copied into the mount or synced back on exit. Shrinking this set
  // re-introduces repo pollution from `npx prpm install` / `npx skills add`;
  // expand via review, not silently.
  assert.deepEqual([...SKILL_INSTALL_IGNORED_PATTERNS], [
    '.agents',
    '.claude/skills',
    '.factory/skills',
    '.kiro/skills',
    'skills',
    '.opencode',
    '.skills',
    'prpm.lock',
    'skills-lock.json'
  ]);
});

// Integration-ish subprocess helper: spawn the built CLI, collect stderr,
// and return once the child exits. We force the harness binary to fail to
// spawn (PATH scrubbed) so these runs terminate quickly regardless of what
// the dispatch path tries next — the assertions target stderr shape alone.
async function runCliCapturingStderr(args: string[]): Promise<{
  stderr: string;
  exitCode: number | null;
}> {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  // Tests run out of dist/, so cli.js is a sibling.
  const cliPath = join(here, 'cli.js');

  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      // Force any harness spawn to ENOENT so the run terminates quickly.
      PATH: '/nonexistent-path-for-test',
      POSTHOG_API_KEY: 'dummy'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (buf: Buffer) => {
    stderr += buf.toString();
  });

  const exitCode: number | null = await new Promise((resolve) => {
    let settled = false;
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    });
    // Safety net — kill after 15s so a hung subprocess never wedges the suite.
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    }, 15_000);
  });

  return { stderr, exitCode };
}

test('main: --clean on a one-shot run emits the ignore note', async () => {
  const { stderr } = await runCliCapturingStderr([
    'agent',
    '--clean',
    'posthog',
    'hello'
  ]);
  assert.match(stderr, /--clean is ignored for one-shot runs/);
});

test('main: --clean on an interactive non-claude session warns and proceeds without mount', async () => {
  // npm-provenance-publisher@best runs on codex. --clean should warn and the
  // run should continue down the non-mount spawn path (which then fails to
  // spawn codex because PATH is scrubbed). We should NEVER see a
  // "clean mount → …" line, which the clean branch emits before calling
  // launchOnMount.
  const { stderr } = await runCliCapturingStderr([
    'agent',
    '--clean',
    'npm-provenance-publisher@best'
  ]);
  assert.match(
    stderr,
    /--clean is only supported for the claude harness/,
    'expected non-claude clean warning to surface'
  );
  assert.ok(
    !/clean mount →/.test(stderr),
    `expected the clean mount branch to be skipped; saw stderr:\n${stderr}`
  );
});
