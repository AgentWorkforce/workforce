import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_VERSION,
  CLEAN_IGNORED_PATTERNS,
  CREATE_SELECTOR,
  SKILL_INSTALL_IGNORED_PATTERNS,
  acquireSkillCacheLock,
  applyAcceptedPatches,
  assertSafeRelativePath,
  buildPickCandidates,
  buildRelayfileMountPatterns,
  buildMountGitExcludeBlock,
  buildSidecarBody,
  configureGitForMount,
  decideCleanMode,
  formatSandboxMountReadyMessage,
  loadSidecarForSelection,
  parseAgentArgs,
  parseInstallArgs,
  parseCreateArgs,
  parseProposals,
  promptYesNoSync,
  readSingleCharChoice,
  resolveEnvCheckIntervalMs,
  resolveSystemPromptPlaceholders,
  stripAgentFlag,
  type ImproverProposal,
  type ResolvedSidecar
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

function writeStandaloneCodexPersona(workforceHome: string, id = 'local-codex'): string {
  const personaDir = join(workforceHome, 'personas');
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(
    join(personaDir, `${id}.json`),
    JSON.stringify({
      id,
      intent: 'review',
      tags: ['review'],
      description: 'Local no-skill codex persona for CLI subprocess tests.',
      harness: 'codex',
      model: 'test-codex',
      systemPrompt: 'Run the local codex test harness.',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 30 }
    }),
    'utf8'
  );
  return id;
}

test('parseAgentArgs: --install-in-repo sets flag and preserves positional selector', () => {
  const { flags, positional } = parseAgentArgs(['--install-in-repo', 'local-codex@best']);
  assert.equal(flags.installInRepo, true);
  assert.equal(flags.noLaunchMetadata, false);
  assert.deepEqual(positional, ['local-codex@best']);
});

test('parseAgentArgs: --no-launch-metadata sets flag and preserves positional selector', () => {
  const { flags, positional } = parseAgentArgs(['--no-launch-metadata', 'local-codex@best']);
  assert.equal(flags.noLaunchMetadata, true);
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['local-codex@best']);
});

test('parseAgentArgs: preserves trailing positionals after the selector', () => {
  const { flags, positional } = parseAgentArgs([
    '--install-in-repo',
    'local-codex@best-value',
    'extra-arg'
  ]);
  assert.equal(flags.installInRepo, true);
  assert.equal(flags.noLaunchMetadata, false);
  assert.deepEqual(positional, ['local-codex@best-value', 'extra-arg']);
});

test('parseAgentArgs: no flags → installInRepo false', () => {
  const { flags, positional } = parseAgentArgs(['local-codex']);
  assert.equal(flags.installInRepo, false);
  assert.equal(flags.noLaunchMetadata, false);
  assert.equal(flags.dryRun, false);
  assert.deepEqual(positional, ['local-codex']);
});

test('parseAgentArgs: --dry-run sets flag and preserves positional selector', () => {
  const { flags, positional } = parseAgentArgs(['--dry-run', 'local-codex@best']);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.installInRepo, false);
  assert.equal(flags.noLaunchMetadata, false);
  assert.deepEqual(positional, ['local-codex@best']);
});

test('parseAgentArgs: --no-skill-cache and --refresh-skills set flags', () => {
  // parseAgentArgs reads AGENTWORKFORCE_NO_SKILL_CACHE for the default; isolate
  // it so the env on the running machine can't make the default-false cases flaky.
  const prevNoCache = process.env.AGENTWORKFORCE_NO_SKILL_CACHE;
  delete process.env.AGENTWORKFORCE_NO_SKILL_CACHE;
  try {
    const a = parseAgentArgs(['--no-skill-cache', 'persona@best']);
    assert.equal(a.flags.noSkillCache, true);
    assert.equal(a.flags.refreshSkills, false);
    assert.deepEqual(a.positional, ['persona@best']);

    const b = parseAgentArgs(['--refresh-skills', 'persona@best']);
    assert.equal(b.flags.refreshSkills, true);
    assert.equal(b.flags.noSkillCache, false);
    assert.deepEqual(b.positional, ['persona@best']);

    // Both compose with each other and with the existing flags.
    const c = parseAgentArgs([
      '--no-skill-cache',
      '--refresh-skills',
      '--install-in-repo',
      'persona@best'
    ]);
    assert.equal(c.flags.noSkillCache, true);
    assert.equal(c.flags.refreshSkills, true);
    assert.equal(c.flags.installInRepo, true);
  } finally {
    if (prevNoCache === undefined) delete process.env.AGENTWORKFORCE_NO_SKILL_CACHE;
    else process.env.AGENTWORKFORCE_NO_SKILL_CACHE = prevNoCache;
  }
});

test('parseAgentArgs: --check-upstream and --no-check-upstream set flags', () => {
  const a = parseAgentArgs(['--check-upstream', 'p@best']);
  assert.equal(a.flags.checkUpstream, true);
  assert.equal(a.flags.noCheckUpstream, false);

  const b = parseAgentArgs(['--no-check-upstream', 'p@best']);
  assert.equal(b.flags.noCheckUpstream, true);
  assert.equal(b.flags.checkUpstream, false);

  const c = parseAgentArgs([
    '--check-upstream',
    '--refresh-skills',
    '--no-skill-cache',
    'p@best'
  ]);
  assert.equal(c.flags.checkUpstream, true);
  assert.equal(c.flags.refreshSkills, true);
  assert.equal(c.flags.noSkillCache, true);
});

test('parseAgentArgs: --dry-run composes with other flags', () => {
  const { flags, positional } = parseAgentArgs([
    '--dry-run',
    '--install-in-repo',
    'local-codex@best-value'
  ]);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.installInRepo, true);
  assert.deepEqual(positional, ['local-codex@best-value']);
});

test('parseAgentArgs: -- stops flag parsing, positional args after are preserved', () => {
  const { flags, positional } = parseAgentArgs([
    '--',
    '--install-in-repo',
    'local-codex'
  ]);
  // --install-in-repo AFTER `--` is positional, not a flag.
  assert.equal(flags.installInRepo, false);
  assert.equal(flags.noLaunchMetadata, false);
  assert.deepEqual(positional, ['--install-in-repo', 'local-codex']);
});

test('parseInstallArgs: accepts package specs, repeatable persona flags, and overwrite', () => {
  assert.deepEqual(
    parseInstallArgs([
      '@scope/pkg@1.2.3',
      '--persona',
      'relay-orchestrator',
      '--persona',
      'code-reviewer',
      '--overwrite'
    ]),
    {
      source: '@scope/pkg@1.2.3',
      personaIds: ['relay-orchestrator', 'code-reviewer'],
      overwrite: true
    }
  );
});

test('parseCreateArgs: runs persona-maker and preserves agent flags', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-args-'));
  const prev = process.env.AGENT_WORKFORCE_HOME;
  process.env.AGENT_WORKFORCE_HOME = join(root, 'home', '.agentworkforce', 'workforce');
  try {
    const { flags, selector, inputValues } = parseCreateArgs([
      '--install-in-repo',
      '--no-launch-metadata',
      '--save-in-directory=user'
    ]);
    assert.equal(selector, CREATE_SELECTOR);
    assert.equal(flags.installInRepo, true);
    assert.equal(flags.noLaunchMetadata, true);
    assert.equal(
      inputValues.TARGET_DIR,
      join(root, 'home', '.agentworkforce', 'workforce', 'personas')
    );
    assert.equal(inputValues.CREATE_MODE, 'local');
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKFORCE_HOME;
    else process.env.AGENT_WORKFORCE_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCreateArgs: rejects positional selectors because create has a fixed persona', () => {
  const trap = trapExit();
  try {
    assert.throws(() => parseCreateArgs(['local-codex']), /__exit_trap__:1/);
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /create: unexpected argument "local-codex"/);
    assert.match(trap.stderr, /always runs persona-maker/);
  } finally {
    trap.restore();
  }
});

test('parseCreateArgs: defaults to cwd target and creates the persona dir if missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-cwd-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.AGENT_WORKFORCE_HOME;
  process.env.AGENT_WORKFORCE_HOME = join(root, 'home', '.agentworkforce', 'workforce');
  try {
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    process.chdir(project);
    // process.chdir resolves symlinks (e.g. /var → /private/var on macOS), so
    // anchor the expected path to the post-chdir cwd rather than `project`.
    const expected = join(process.cwd(), '.agentworkforce', 'workforce', 'personas');
    const { inputValues } = parseCreateArgs([]);
    assert.equal(inputValues.TARGET_DIR, expected);
    assert.equal(inputValues.CREATE_MODE, 'local');
    assert.ok(
      existsSync(expected),
      'create should mkdir -p the cwd-local persona directory when it is missing'
    );
  } finally {
    if (prevHome === undefined) delete process.env.AGENT_WORKFORCE_HOME;
    else process.env.AGENT_WORKFORCE_HOME = prevHome;
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCreateArgs: saved defaultCreateTarget overrides the cwd default', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-saved-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.AGENT_WORKFORCE_HOME;
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  process.env.AGENT_WORKFORCE_HOME = workforceHome;
  try {
    mkdirSync(workforceHome, { recursive: true });
    writeFileSync(
      join(workforceHome, 'config.json'),
      JSON.stringify({ personaDirs: [join(workforceHome, 'personas')], defaultCreateTarget: 'user' }),
      'utf8'
    );
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    process.chdir(project);
    const { inputValues } = parseCreateArgs([]);
    assert.equal(inputValues.TARGET_DIR, join(workforceHome, 'personas'));
    assert.equal(inputValues.CREATE_MODE, 'local');
  } finally {
    if (prevHome === undefined) delete process.env.AGENT_WORKFORCE_HOME;
    else process.env.AGENT_WORKFORCE_HOME = prevHome;
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCreateArgs: --save-in-directory accepts a space-separated value', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-space-'));
  const prev = process.env.AGENT_WORKFORCE_HOME;
  process.env.AGENT_WORKFORCE_HOME = join(root, 'home', '.agentworkforce', 'workforce');
  try {
    const { inputValues } = parseCreateArgs(['--save-in-directory', 'user']);
    assert.equal(
      inputValues.TARGET_DIR,
      join(root, 'home', '.agentworkforce', 'workforce', 'personas')
    );
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKFORCE_HOME;
    else process.env.AGENT_WORKFORCE_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCreateArgs: --save-in-directory rejects blank values instead of falling back to cwd', () => {
  const trap = trapExit();
  try {
    assert.throws(() => parseCreateArgs(['--save-in-directory=']), /__exit_trap__:1/);
    assert.throws(() => parseCreateArgs(['--save-in-directory=   ']), /__exit_trap__:1/);
    assert.throws(() => parseCreateArgs(['--save-in-directory', '']), /__exit_trap__:1/);
    assert.throws(() => parseCreateArgs(['--save-in-directory', '   ']), /__exit_trap__:1/);
    assert.match(trap.stderr, /requires a non-empty value/);
  } finally {
    trap.restore();
  }
});

test('parseCreateArgs: --save-default persists create target in source config', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-default-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  const prev = process.env.AGENT_WORKFORCE_HOME;
  process.env.AGENT_WORKFORCE_HOME = workforceHome;
  try {
    parseCreateArgs(['--save-in-directory=user', '--save-default']);
    const parsed = JSON.parse(readFileSync(join(workforceHome, 'config.json'), 'utf8'));
    assert.equal(parsed.defaultCreateTarget, 'user');
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKFORCE_HOME;
    else process.env.AGENT_WORKFORCE_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('decideCleanMode: claude defaults to mount (parity with opencode)', () => {
  // claude and opencode both default to the sandbox mount; the includeGit
  // path in relayfile 0.6 keeps `.git` in the mount so git operations work
  // inside it. --install-in-repo is the only opt-out.
  assert.deepEqual(decideCleanMode('claude'), { useClean: true });
});

test('decideCleanMode: claude + --install-in-repo disengages mount', () => {
  assert.deepEqual(decideCleanMode('claude', true), { useClean: false });
});

test('decideCleanMode: opencode defaults to mount (skills would otherwise land in repo)', () => {
  // Opencode has no installRoot support in the SDK, so the mount is the only
  // way to keep `.opencode/skills/`, `.agents/skills/`, prpm.lock, etc. out
  // of the real repo. Default-on for non-in-repo runs.
  assert.deepEqual(decideCleanMode('opencode'), { useClean: true });
});

test('decideCleanMode: opencode + --install-in-repo → no mount', () => {
  assert.deepEqual(decideCleanMode('opencode', true), { useClean: false });
});

test('decideCleanMode: codex defaults to mount (parity with claude/opencode)', () => {
  // All three harnesses default to the mount; --install-in-repo is the
  // single opt-out. Codex needs the mount so persona-supplied AGENTS.md
  // sidecars can be materialized without overwriting the user's real-cwd
  // copy, and so any per-session writes stay sandboxed.
  assert.deepEqual(decideCleanMode('codex'), { useClean: true });
  assert.deepEqual(decideCleanMode('codex', true), { useClean: false });
});

test('formatSandboxMountReadyMessage: appends mount metrics when available', () => {
  assert.equal(
    formatSandboxMountReadyMessage('/tmp/mount', {
      initialMountDurationMs: 123,
      initialFileCount: 456
    }),
    'Sandbox mount ready (123ms, 456 files) → /tmp/mount'
  );
});

test('formatSandboxMountReadyMessage: omits metrics when linked against an older mount handle', () => {
  assert.equal(
    formatSandboxMountReadyMessage('/tmp/mount', {
      initialMountDurationMs: 123
    }),
    'Sandbox mount ready → /tmp/mount'
  );
  assert.equal(
    formatSandboxMountReadyMessage('/tmp/mount', {
      initialFileCount: 456
    }),
    'Sandbox mount ready → /tmp/mount'
  );
  assert.equal(
    formatSandboxMountReadyMessage('/tmp/mount', {}),
    'Sandbox mount ready → /tmp/mount'
  );
});

test('stripAgentFlag: removes --agent <name> pair preserving surrounding args', () => {
  // Degrade path: when the CLI cannot materialize opencode.json (non-mount
  // --install-in-repo), it strips the --agent selector so opencode launches
  // with its default agent rather than failing to resolve the unknown one.
  assert.deepEqual(
    stripAgentFlag(['--agent', 'persona-maker']),
    []
  );
  assert.deepEqual(
    stripAgentFlag(['--foo', '--agent', 'persona-maker', '--bar']),
    ['--foo', '--bar']
  );
  assert.deepEqual(
    stripAgentFlag(['--keep-me']),
    ['--keep-me']
  );
});

test('stripAgentFlag: trailing --agent without a value is preserved (caller decides)', () => {
  // Defensive: don't swallow an argv that looks malformed — let the harness
  // reject it so the bug surfaces instead of getting silently stripped.
  assert.deepEqual(stripAgentFlag(['--agent']), ['--agent']);
});

test('stripAgentFlag: removes every --agent pair, not just the first', () => {
  // Current producer emits exactly one pair, so behavior is equivalent
  // today, but "strip all" is idempotent and safer if a future caller ever
  // appends a second --agent for any reason.
  assert.deepEqual(
    stripAgentFlag(['--agent', 'a', '--agent', 'b']),
    []
  );
  assert.deepEqual(
    stripAgentFlag(['--before', '--agent', 'a', '--mid', '--agent', 'b', '--after']),
    ['--before', '--mid', '--after']
  );
});

test('assertSafeRelativePath: accepts typical relative paths', () => {
  // Sanity: representative safe paths the opencode + future harnesses emit.
  assert.doesNotThrow(() => assertSafeRelativePath('opencode.json'));
  assert.doesNotThrow(() => assertSafeRelativePath('.opencode/config.json'));
  assert.doesNotThrow(() => assertSafeRelativePath('nested/dir/file.json'));
});

test('assertSafeRelativePath: rejects empty, absolute, and path-traversal inputs', () => {
  // Guards materialization against a malformed or adversarial persona trying
  // to escape the mount via `join(dir, path)` and overwrite files outside
  // the sandbox. Failure must surface with a clear message BEFORE any
  // writeFileSync runs.
  assert.throws(() => assertSafeRelativePath(''), /non-empty/);
  assert.throws(() => assertSafeRelativePath('/etc/passwd'), /absolute/);
  assert.throws(() => assertSafeRelativePath('../escape.json'), /\.\./);
  assert.throws(() => assertSafeRelativePath('ok/../escape.json'), /\.\./);
  assert.throws(() => assertSafeRelativePath('a/../../b.json'), /\.\./);
});

test('CLEAN_IGNORED_PATTERNS: covers the declared repo-level claude config files', () => {
  // Pinned order + exact set — canary for anyone accidentally shrinking the
  // hidden-from-session footprint. Expand via review, not silently.
  assert.deepEqual([...CLEAN_IGNORED_PATTERNS], [
    'CLAUDE.md',
    'CLAUDE.local.md',
    '.claude',
    '.mcp.json',
    // AGENTS.md hidden so per-persona sidecar materialization into the
    // mount doesn't leak the user's real-cwd file in or sync back out.
    'AGENTS.md'
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
    'skills-lock.json',
    // AGENTS.md (opencode sidecar) materialized into the mount; hide so
    // the user's real-cwd file doesn't copy in and the persona-written
    // file doesn't sync back.
    'AGENTS.md'
  ]);
});

test('buildRelayfileMountPatterns: merges Relayfile dotfiles with built-in claude mount rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-relayfile-patterns-'));
  try {
    writeFileSync(join(dir, '.agentignore'), 'secrets/\n.env\n', 'utf8');
    writeFileSync(join(dir, '.agentreadonly'), 'package.json\n*.lock\n', 'utf8');
    writeFileSync(join(dir, '.nextjs-marketing.agentignore'), 'coverage/\n', 'utf8');
    writeFileSync(
      join(dir, '.nextjs-marketing.agentreadonly'),
      'app/api/**\nauth/**\n',
      'utf8'
    );

    const patterns = buildRelayfileMountPatterns({
      projectDir: dir,
      personaId: 'nextjs-marketing',
      harness: 'claude',
      mount: {
        ignoredPatterns: ['tmp/persona/**'],
        readonlyPatterns: ['*', '!app/**']
      },
      configFilePaths: ['opencode.json']
    });

    assert.deepEqual(patterns.ignoredPatterns, [
      'secrets/',
      '.env',
      'coverage/',
      'tmp/persona/**',
      ...CLEAN_IGNORED_PATTERNS,
      'opencode.json'
    ]);
    assert.deepEqual(patterns.readonlyPatterns, [
      'package.json',
      '*.lock',
      'app/api/**',
      'auth/**',
      '*',
      '!app/**'
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Integration-ish subprocess helper: spawn the built CLI, collect stderr,
// and return once the child exits. We force the harness binary to fail to
// spawn (PATH scrubbed) so these runs terminate quickly regardless of what
// the dispatch path tries next — the assertions target stderr shape alone.
async function runCliCapturingStderr(args: string[]): Promise<{
  stderr: string;
  stdout: string;
  exitCode: number | null;
}>;
async function runCliCapturingStderr(
  args: string[],
  extraEnv: NodeJS.ProcessEnv
): Promise<{
  stderr: string;
  stdout: string;
  exitCode: number | null;
}>;
async function runCliCapturingStderr(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{
  stderr: string;
  stdout: string;
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
      AGENT_WORKFORCE_HOME: join(tmpdir(), `aw-cli-empty-home-${process.pid}`),
      ...extraEnv,
      // Force any harness spawn to ENOENT so the run terminates quickly.
      PATH: extraEnv.PATH ?? '/nonexistent-path-for-test',
      POSTHOG_API_KEY: extraEnv.POSTHOG_API_KEY ?? 'dummy'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (buf: Buffer) => {
    stderr += buf.toString();
  });
  child.stdout.on('data', (buf: Buffer) => {
    stdout += buf.toString();
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

  return { stderr, stdout, exitCode };
}

test('main: extra positional after the persona selector is rejected', async () => {
  const { stderr, exitCode } = await runCliCapturingStderr([
    'agent',
    'local-codex',
    'hello'
  ]);
  assert.match(stderr, /unexpected argument "hello"/);
  assert.equal(exitCode, 1);
});

test('main: --version prints the package version', async () => {
  // Point AGENT_WORKFORCE_HOME at an empty tmpdir so the load-time
  // local-persona scan can't surface warnings from whatever the developer has
  // installed under ~/.agentworkforce.
  const root = mkdtempSync(join(tmpdir(), 'aw-version-cli-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  mkdirSync(join(workforceHome, 'personas'), { recursive: true });
  try {
    const { stderr, stdout, exitCode } = await runCliCapturingStderr(
      ['--version'],
      { AGENT_WORKFORCE_HOME: workforceHome }
    );
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.equal(stdout, `${CLI_VERSION}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: persona compile dispatches to the typed persona compiler', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-cli-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  mkdirSync(join(workforceHome, 'personas'), { recursive: true });
  const personaPath = join(root, 'persona.ts');
  writeFileSync(
    personaPath,
    `export default {
  id: 'cli-compiled',
  intent: 'review',
  description: 'Compiled through the CLI dispatcher.',
  onEvent: './agent.ts',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 }
};
`,
    'utf8'
  );

  try {
    const { stderr, stdout, exitCode } = await runCliCapturingStderr(
      ['persona', 'compile', personaPath],
      { AGENT_WORKFORCE_HOME: workforceHome }
    );
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Compiled .*persona\.ts -> .*persona\.json \(cli-compiled\)/);
    const compiled = JSON.parse(readFileSync(join(root, 'persona.json'), 'utf8')) as {
      id: string;
    };
    assert.equal(compiled.id, 'cli-compiled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: deploy dry-run accepts an authored persona.ts path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-deploy-cli-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  mkdirSync(join(workforceHome, 'personas'), { recursive: true });
  const personaPath = join(root, 'persona.ts');
  writeFileSync(join(root, 'agent.ts'), 'export default async () => {};', 'utf8');
  writeFileSync(
    personaPath,
    `export default {
  id: 'cli-deploy-source',
  intent: 'review',
  description: 'Deploy through the CLI dispatcher.',
  cloud: true,
  schedules: [{ name: 'daily', cron: '0 9 * * *' }],
  onEvent: './agent.ts',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 }
};
`,
    'utf8'
  );

  try {
    const { stderr, stdout, exitCode } = await runCliCapturingStderr(
      ['deploy', personaPath, '--mode', 'dev', '--dry-run'],
      { AGENT_WORKFORCE_HOME: workforceHome }
    );
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /ok: cli-deploy-source \(dry-run\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: local personas with custom intents appear in list and unknown-persona help', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'aw-custom-intent-cli-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  const userPersonaDir = join(workforceHome, 'personas');
  mkdirSync(userPersonaDir, { recursive: true });
  writeFileSync(
    join(userPersonaDir, 'nextjs-web-steward.json'),
    JSON.stringify({
      id: 'nextjs-web-steward',
      intent: 'nextjs-web-steward',
      tags: ['implementation'],
      description: 'Stewards Next.js web surfaces.',
      harness: 'opencode',
      model: 'opencode/gpt-5-nano',
      systemPrompt: 'Implement Next.js UI work carefully.',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 30 }
    }),
    'utf8'
  );

  try {
    const env = { AGENT_WORKFORCE_HOME: workforceHome };
    const list = await runCliCapturingStderr(['list', '--json'], env);
    assert.equal(list.exitCode, 0);
    assert.equal(list.stderr, '');
    const parsed = JSON.parse(list.stdout) as {
      personas: Array<{ persona: string; intent: string }>;
    };
    assert.ok(
      parsed.personas.some(
        (row) =>
          row.persona === 'nextjs-web-steward' &&
          row.intent === 'nextjs-web-steward'
      ),
      'custom-intent local persona should appear in the listing'
    );

    const missing = await runCliCapturingStderr(['agent', 'does-not-exist'], env);
    assert.equal(missing.exitCode, 1);
    assert.doesNotMatch(missing.stderr, /intent must be one of/);
    assert.match(missing.stderr, /NAME\s+\|\s+DESCRIPTION/);
    assert.match(
      missing.stderr,
      /nextjs-web-steward\s+\|\s+Stewards Next\.js web surfaces\./
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: sources add/list/remove manages persona source dirs', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'aw-sources-cli-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  const userPersonaDir = join(workforceHome, 'personas');
  const customDir = join(root, 'checked-out-personas');
  mkdirSync(userPersonaDir, { recursive: true });
  mkdirSync(customDir, { recursive: true });
  try {
    const env = { AGENT_WORKFORCE_HOME: workforceHome };
    let res = await runCliCapturingStderr(['sources', 'list', '--json'], env);
    assert.equal(res.exitCode, 0);
    let parsed = JSON.parse(res.stdout) as {
      personaDirs: string[];
      sources: Array<{ source: string; config: string; dir: string }>;
    };
    assert.deepEqual(parsed.personaDirs, [userPersonaDir]);
    assert.equal(parsed.sources[0]?.source, 'cwd');
    assert.equal(parsed.sources[1]?.source, 'user');

    res = await runCliCapturingStderr(
      ['sources', 'add', customDir, '--position', '1'],
      env
    );
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /Added persona source directory/);

    res = await runCliCapturingStderr(['sources', 'list', '--json'], env);
    assert.equal(res.exitCode, 0);
    parsed = JSON.parse(res.stdout) as typeof parsed;
    assert.deepEqual(parsed.personaDirs, [customDir, userPersonaDir]);
    assert.equal(parsed.sources[1]?.source, 'dir:1');
    assert.equal(parsed.sources[2]?.source, 'user');

    res = await runCliCapturingStderr(['sources', 'remove', '1'], env);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /Removed persona source directory/);

    res = await runCliCapturingStderr(['sources', 'list', '--json'], env);
    assert.equal(res.exitCode, 0);
    parsed = JSON.parse(res.stdout) as typeof parsed;
    assert.deepEqual(parsed.personaDirs, [userPersonaDir]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildMountGitExcludeBlock: emits a header comment and one line per pattern, leading and trailing newline', () => {
  const out = buildMountGitExcludeBlock(['CLAUDE.md', '.claude']);
  // Leading newline ensures the block stays separated from any prior
  // content already in .git/info/exclude.
  assert.ok(out.startsWith('\n'), 'expected leading newline');
  assert.ok(out.endsWith('\n'), 'expected trailing newline');
  assert.match(out, /^# agentworkforce:/m);
  assert.match(out, /^CLAUDE\.md$/m);
  assert.match(out, /^\.claude$/m);
});

test('configureGitForMount: marks tracked hidden paths as skip-worktree and appends to .git/info/exclude', async () => {
  // Integration test against a real local git repo: stand up a tiny tracked
  // tree, run the configurator, and verify the index/exclude state. Mirrors
  // the runtime call site (onBeforeLaunch in runInteractive), so a regression
  // in either the ls-files plumbing or the exclude-block format surfaces here.
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'aw-git-mount-'));
  try {
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    // commit.gpgsign defaults vary by host; force off so this test doesn't
    // hang on a missing/locked GPG agent.
    run('config', 'commit.gpgsign', 'false');

    writeFileSync(join(dir, 'CLAUDE.md'), 'hidden\n');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'config.json'), '{}\n');
    writeFileSync(join(dir, 'src.ts'), 'visible\n');

    run('add', '.');
    run('commit', '-q', '-m', 'init');

    configureGitForMount(dir, ['CLAUDE.md', '.claude']);

    const excludeText = readFileSync(
      join(dir, '.git', 'info', 'exclude'),
      'utf8'
    );
    assert.match(excludeText, /^CLAUDE\.md$/m);
    assert.match(excludeText, /^\.claude$/m);
    assert.match(excludeText, /^# agentworkforce:/m);

    // `git ls-files -v` prefixes each path with a one-letter status: 'H' for
    // unmodified, 'S' for skip-worktree. Hidden tracked files should flip to
    // 'S'; visible files stay 'H'.
    const ls = run('ls-files', '-v');
    const out = ls.stdout.toString('utf8');
    assert.match(out, /^S CLAUDE\.md$/m);
    assert.match(out, /^S \.claude\/config\.json$/m);
    assert.match(out, /^H src\.ts$/m);

    // Temp exclude list used internally must be cleaned up.
    const fs = await import('node:fs');
    assert.ok(
      !fs.existsSync(join(dir, '.git', 'info', '.aw-skip-list')),
      'expected internal scratch file to be removed'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configureGitForMount: no-op when the mount has no .git', async () => {
  // Project isn't a repo, or relayfile ran with includeGit:false. Helper
  // must return silently rather than throw — the rest of onBeforeLaunch
  // still has install + configFile work to do.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'aw-git-noop-'));
  try {
    assert.doesNotThrow(() =>
      configureGitForMount(dir, ['CLAUDE.md', '.claude'])
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configureGitForMount: empty patterns is a no-op', () => {
  // Defensive: callers that compute patterns dynamically may end up with
  // an empty list; we should not touch the index in that case.
  assert.doesNotThrow(() => configureGitForMount('/nonexistent-path', []));
});

test('buildSidecarBody: overwrite mode returns persona content as-is', () => {
  const sidecar: ResolvedSidecar = {
    mountFile: 'CLAUDE.md',
    personaContent: '# Persona\n',
    mode: 'overwrite'
  };
  // Even if a real-cwd file exists, overwrite must ignore it.
  const dir = mkdtempSync(join(tmpdir(), 'aw-sidecar-'));
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Real\n', 'utf8');
    assert.equal(buildSidecarBody(sidecar, dir), '# Persona\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSidecarBody: extend mode prepends real-cwd content with separator', () => {
  const sidecar: ResolvedSidecar = {
    mountFile: 'CLAUDE.md',
    personaContent: '# Persona\n',
    mode: 'extend'
  };
  const dir = mkdtempSync(join(tmpdir(), 'aw-sidecar-'));
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Real\n', 'utf8');
    assert.equal(buildSidecarBody(sidecar, dir), '# Real\n\n\n---\n\n# Persona\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSidecarBody: extend mode degrades to overwrite when real file is missing', () => {
  const sidecar: ResolvedSidecar = {
    mountFile: 'AGENTS.md',
    personaContent: '# Only persona\n',
    mode: 'extend'
  };
  const dir = mkdtempSync(join(tmpdir(), 'aw-sidecar-'));
  try {
    assert.equal(buildSidecarBody(sidecar, dir), '# Only persona\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSidecarForSelection: prefers inlined Content over path; selects by harness', () => {
  const baseSelection = {
    personaId: 'p',
    harness: 'claude' as const,
    model: 'claude-3-5-sonnet',
    systemPrompt: 'You are a test persona.',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 },
    skills: [],
    rationale: 'test',
    claudeMdContent: '# Inlined\n',
    claudeMdMode: 'overwrite' as const
  };
  const { sidecar } = loadSidecarForSelection(baseSelection);
  assert.ok(sidecar);
  assert.equal(sidecar.mountFile, 'CLAUDE.md');
  assert.equal(sidecar.personaContent, '# Inlined\n');
  assert.equal(sidecar.mode, 'overwrite');

  // codex picks AGENTS.md, not CLAUDE.md
  const codexSelection = {
    ...baseSelection,
    harness: 'codex' as const,
    agentsMdContent: '# agents inlined\n'
  };
  const codexOut = loadSidecarForSelection(codexSelection);
  assert.equal(codexOut.sidecar?.mountFile, 'AGENTS.md');
  assert.equal(codexOut.sidecar?.personaContent, '# agents inlined\n');

  // codex with no sidecar fields returns nothing
  const codexNoSidecar = {
    ...baseSelection,
    harness: 'codex' as const,
    claudeMdContent: undefined
  };
  const codexEmpty = loadSidecarForSelection(codexNoSidecar);
  assert.equal(codexEmpty.sidecar, undefined);
});

test('loadSidecarForSelection: opencode picks agentsMd, not claudeMd', () => {
  const selection = {
    personaId: 'p',
    harness: 'opencode' as const,
    model: 'gpt-5.2',
    systemPrompt: 'X',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 },
    skills: [],
    rationale: 'test',
    claudeMdContent: '# claude\n',
    agentsMdContent: '# agents\n'
  };
  const { sidecar } = loadSidecarForSelection(selection);
  assert.equal(sidecar?.mountFile, 'AGENTS.md');
  assert.equal(sidecar?.personaContent, '# agents\n');
});

test('main: codex sessions engage the sandbox mount by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-cli-mount-'));
  try {
    const workforceHome = join(root, '.agentworkforce', 'workforce');
    const personaId = writeStandaloneCodexPersona(workforceHome);
    // Codex defaults to a relayfile mount in parity with claude/opencode so
    // persona-supplied AGENTS.md sidecars and per-session writes stay sandboxed.
    const { stderr } = await runCliCapturingStderr(
      ['agent', `${personaId}`],
      { AGENT_WORKFORCE_HOME: workforceHome }
    );
    assert.match(
      stderr,
      /sandbox mount →/,
      `expected the mount branch to engage; saw stderr:\n${stderr}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: codex --install-in-repo disengages the sandbox mount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-cli-no-mount-'));
  try {
    const workforceHome = join(root, '.agentworkforce', 'workforce');
    const personaId = writeStandaloneCodexPersona(workforceHome);
    // The single opt-out: --install-in-repo. Confirms parity with claude/
    // opencode where the same flag turns the mount off.
    const { stderr } = await runCliCapturingStderr(
      ['agent', `${personaId}`, '--install-in-repo'],
      { AGENT_WORKFORCE_HOME: workforceHome }
    );
    assert.ok(
      !/sandbox mount →/.test(stderr),
      `expected the mount branch to be skipped under --install-in-repo; saw stderr:\n${stderr}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: preserves the harness exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-cli-exit-code-'));
  try {
    const codex = join(dir, 'codex');
    writeFileSync(
      codex,
      `#!/usr/bin/env node
process.stderr.write('fake codex failed\\n');
process.exit(7);
`,
      'utf8'
    );
    chmodSync(codex, 0o755);

    const workforceHome = join(dir, '.agentworkforce', 'workforce');
    const personaId = writeStandaloneCodexPersona(workforceHome);
    const res = await runCliCapturingStderr(['agent', `${personaId}`, '--install-in-repo'], {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      AGENT_WORKFORCE_HOME: workforceHome,
      AGENTWORKFORCE_LAUNCH_METADATA: '0'
    });

    assert.equal(res.exitCode, 7);
    assert.match(res.stderr, /fake codex failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPickCandidates: includes built-in personas with required projection fields', () => {
  const candidates = buildPickCandidates();
  assert.ok(candidates.length > 0, 'expected at least one candidate');
  const personaMaker = candidates.find((c) => c.id === 'persona-maker');
  assert.ok(personaMaker, 'persona-maker should be present in candidates');
  assert.equal(personaMaker?.intent, 'persona-authoring');
  assert.ok(Array.isArray(personaMaker?.tags));
  assert.ok(personaMaker && personaMaker.description.length > 0);
  // Sorted by id so the picker prompt is stable.
  const ids = candidates.map((c) => c.id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ids, sorted);
});

test('promptYesNoSync: returns false when not a TTY (skips prompt)', () => {
  const writes: string[] = [];
  const result = promptYesNoSync('proceed? ', {
    isTTY: false,
    write: (chunk) => writes.push(chunk),
    read: () => 'y'
  });
  assert.equal(result, false);
  assert.deepEqual(writes, [], 'should not write when non-TTY');
});

test('promptYesNoSync: TTY + "y" → true', () => {
  const writes: string[] = [];
  const result = promptYesNoSync('proceed? ', {
    isTTY: true,
    write: (chunk) => writes.push(chunk),
    read: () => 'y'
  });
  assert.equal(result, true);
  assert.deepEqual(writes, ['proceed? ']);
});

test('promptYesNoSync: TTY + "yes" (any case, with whitespace) → true', () => {
  for (const answer of ['Y', 'YES', '  yes  ', 'Yes\r']) {
    const result = promptYesNoSync('?', {
      isTTY: true,
      write: () => {},
      read: () => answer
    });
    assert.equal(result, true, `answer ${JSON.stringify(answer)} should yield true`);
  }
});

test('promptYesNoSync: TTY + empty/non-y answer → false (default no)', () => {
  for (const answer of ['', 'n', 'no', undefined, 'maybe']) {
    const result = promptYesNoSync('?', {
      isTTY: true,
      write: () => {},
      read: () => answer
    });
    assert.equal(result, false, `answer ${JSON.stringify(answer)} should yield false`);
  }
});

test('parseProposals: validates schema and returns typed proposals', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'tighten-description',
        summary: 'Sharpen description',
        rationale: 'Old description listed unrelated capabilities',
        patches: [
          { path: 'description', op: 'set', value: 'New description' }
        ]
      }
    ]
  });
  const parsed = parseProposals(raw);
  assert.equal(parsed.personaId, 'foo');
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].id, 'tighten-description');
  assert.equal(parsed.proposals[0].patches[0].op, 'set');
});

test('parseProposals: rejects malformed JSON with a descriptive error', () => {
  assert.throws(() => parseProposals('not-json'), /not valid JSON/);
});

test('parseProposals: rejects bad patch op', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [{ path: 'description', op: 'delete', value: '' }]
      }
    ]
  });
  assert.throws(() => parseProposals(raw), /op must be "set" or "append"/);
});

test('parseProposals: empty proposals array is valid', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: []
  });
  const parsed = parseProposals(raw);
  assert.equal(parsed.proposals.length, 0);
});

test('parseProposals: synthesizes missing display fields from valid patches', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: '',
        summary: '',
        patches: [{ path: 'description', op: 'set', value: 'New description' }]
      },
      {
        id: 'tighten-system-prompt',
        summary: '   ',
        rationale: '  useful signal  ',
        patches: [{ path: 'systemPrompt', op: 'set', value: 'New prompt' }]
      }
    ]
  });
  const parsed = parseProposals(raw);
  assert.equal(parsed.proposals[0].id, 'proposal-1');
  assert.equal(parsed.proposals[0].summary, 'Update description');
  assert.equal(parsed.proposals[0].rationale, '');
  assert.equal(parsed.proposals[1].summary, 'Tighten system prompt');
  assert.equal(parsed.proposals[1].rationale, 'useful signal');
});

test('applyAcceptedPatches: set replaces top-level field', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-improver-'));
  try {
    const path = join(tmp, 'persona.json');
    writeFileSync(
      path,
      JSON.stringify({ id: 'foo', description: 'old', systemPrompt: 'p' }),
      'utf8'
    );
    const proposals: ImproverProposal[] = [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [{ path: 'description', op: 'set', value: 'new description' }]
      }
    ];
    applyAcceptedPatches(path, proposals);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.description, 'new description');
    assert.equal(after.systemPrompt, 'p', 'unrelated fields untouched');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyAcceptedPatches: set replaces top-level systemPrompt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-improver-'));
  try {
    const path = join(tmp, 'persona.json');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'foo',
        systemPrompt: 'old prompt'
      }),
      'utf8'
    );
    applyAcceptedPatches(path, [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [
          { path: 'systemPrompt', op: 'set', value: 'new prompt' }
        ]
      }
    ]);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.systemPrompt, 'new prompt');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyAcceptedPatches: append adds to skills array (and creates it if missing)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-improver-'));
  try {
    const path = join(tmp, 'persona.json');
    writeFileSync(path, JSON.stringify({ id: 'foo' }), 'utf8');
    applyAcceptedPatches(path, [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [
          {
            path: 'skills',
            op: 'append',
            value: { id: 'a/b', source: 'http://x', description: 'd' }
          }
        ]
      }
    ]);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(after.skills, [{ id: 'a/b', source: 'http://x', description: 'd' }]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyAcceptedPatches: throws when appending to a non-array', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-improver-'));
  try {
    const path = join(tmp, 'persona.json');
    // `skills` is in the append allowlist but the existing value is not an array,
    // so the runtime non-array guard fires (not the allowlist guard).
    writeFileSync(path, JSON.stringify({ id: 'foo', skills: 'oops not array' }), 'utf8');
    assert.throws(
      () =>
        applyAcceptedPatches(path, [
          {
            id: 'p1',
            summary: 's',
            rationale: 'r',
            patches: [{ path: 'skills', op: 'append', value: { id: 'x', source: 'y', description: 'z' } }]
          }
        ]),
      /cannot append to non-array/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseProposals: rejects set on a non-allowlisted path (e.g. id)', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [{ path: 'id', op: 'set', value: 'rebrand' }]
      }
    ]
  });
  assert.throws(() => parseProposals(raw), /set path "id" is not in the allowlist/);
});

test('parseProposals: rejects set on locked runtime fields', () => {
  for (const path of ['model', 'harness', 'harnessSettings.reasoning']) {
    const raw = JSON.stringify({
      personaId: 'foo',
      personaFilePath: '/tmp/foo.json',
      transcriptPath: '',
      proposals: [
        {
          id: 'p1',
          summary: 's',
          rationale: 'r',
          patches: [{ path, op: 'set', value: 'whatever' }]
        }
      ]
    });
    assert.throws(() => parseProposals(raw), /is not in the allowlist/, `path "${path}" should be rejected`);
  }
});

test('parseProposals: rejects append on a non-allowlisted path', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [{ path: 'tags', op: 'append', value: 'extra' }]
      }
    ]
  });
  assert.throws(() => parseProposals(raw), /append path "tags" is not in the allowlist/);
});

test('parseProposals: rejects prototype-pollution path segments', () => {
  for (const path of ['__proto__.polluted', 'constructor.prototype.x', 'harnessSettings.__proto__.x']) {
    const raw = JSON.stringify({
      personaId: 'foo',
      personaFilePath: '/tmp/foo.json',
      transcriptPath: '',
      proposals: [
        {
          id: 'p1',
          summary: 's',
          rationale: 'r',
          patches: [{ path, op: 'set', value: 'x' }]
        }
      ]
    });
    assert.throws(() => parseProposals(raw), /forbidden segment/, `path "${path}" should be rejected`);
  }
});

test('parseProposals: accepts inputs.<NAME> set with env-style key', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [
          { path: 'inputs.NEW_INPUT', op: 'set', value: { description: 'a new input' } }
        ]
      }
    ]
  });
  const parsed = parseProposals(raw);
  assert.equal(parsed.proposals[0].patches[0].path, 'inputs.NEW_INPUT');
});

test('parseProposals: rejects inputs.<bad-name> with non-env-style key', () => {
  const raw = JSON.stringify({
    personaId: 'foo',
    personaFilePath: '/tmp/foo.json',
    transcriptPath: '',
    proposals: [
      {
        id: 'p1',
        summary: 's',
        rationale: 'r',
        patches: [{ path: 'inputs.lowercase', op: 'set', value: { description: 'x' } }]
      }
    ]
  });
  assert.throws(() => parseProposals(raw), /env-style NAME/);
});

test('applyAcceptedPatches: prototype-pollution attempt does not escape and Object.prototype stays clean', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-improver-'));
  try {
    const path = join(tmp, 'persona.json');
    writeFileSync(path, JSON.stringify({ id: 'foo' }), 'utf8');
    assert.throws(
      () =>
        applyAcceptedPatches(path, [
          {
            id: 'p1',
            summary: 's',
            rationale: 'r',
            patches: [{ path: '__proto__.polluted', op: 'set', value: true }]
          }
        ]),
      /forbidden segment/
    );
    // Belt-and-braces: confirm prototype really wasn't touched.
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    // File is untouched (write-back never happens on throw).
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(after, { id: 'foo' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSingleCharChoice: empty Enter returns first valid (default)', () => {
  const writes: string[] = [];
  const choice = readSingleCharChoice('? ', ['n', 'y', 'a', 'q'], {
    write: (chunk) => writes.push(chunk),
    read: () => ''
  });
  assert.equal(choice, 'n');
});

test('readSingleCharChoice: explicit y returns y even with n-first valid', () => {
  const choice = readSingleCharChoice('? ', ['n', 'y', 'a', 'q'], {
    write: () => {},
    read: () => 'y'
  });
  assert.equal(choice, 'y');
});

test('readSingleCharChoice: invalid input loops until valid arrives', () => {
  const reads = ['z', 'huh', 'q'];
  const writes: string[] = [];
  const choice = readSingleCharChoice('? ', ['n', 'y', 'a', 'q'], {
    write: (chunk) => writes.push(chunk),
    read: () => reads.shift()
  });
  assert.equal(choice, 'q');
  // Saw two "invalid choice" reprompts before the valid 'q'.
  const invalidLines = writes.filter((w) => w.includes('invalid choice'));
  assert.equal(invalidLines.length, 2);
});

// --- resolveEnvCheckIntervalMs (PR #124 review: `never` must disable) ----

test('resolveEnvCheckIntervalMs: unset → 24h default', () => {
  const prev = process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL;
  delete process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL;
  try {
    assert.equal(resolveEnvCheckIntervalMs(), 24 * 3_600_000);
  } finally {
    if (prev === undefined) delete process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL;
    else process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = prev;
  }
});

test('resolveEnvCheckIntervalMs: never/off → null (NOT coalesced to default)', () => {
  const prev = process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL;
  try {
    for (const v of ['never', 'off', 'false']) {
      process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = v;
      assert.equal(resolveEnvCheckIntervalMs(), null, `"${v}" must disable checks`);
    }
    process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = '0';
    assert.equal(resolveEnvCheckIntervalMs(), 0); // 0 = always, distinct from null
    process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = '30m';
    assert.equal(resolveEnvCheckIntervalMs(), 1_800_000);
    process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = 'garbage';
    assert.equal(resolveEnvCheckIntervalMs(), 24 * 3_600_000); // unparseable → default
  } finally {
    if (prev === undefined) delete process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL;
    else process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL = prev;
  }
});

// --- acquireSkillCacheLock (PR #124 review: per-fingerprint locking) -----

test('acquireSkillCacheLock: acquires, blocks re-acquire, releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lock-'));
  try {
    const cacheDir = join(dir, 'fp');
    const lock = await acquireSkillCacheLock(cacheDir);
    assert.ok(lock, 'first acquire succeeds');
    assert.equal(existsSync(`${cacheDir}.lock`), true);

    // A held, fresh lock from a live pid (us) is not stolen → second acquire
    // blocks; assert it doesn't resolve within a short window.
    const second = acquireSkillCacheLock(cacheDir);
    const raced = await Promise.race([
      second.then(() => 'acquired'),
      new Promise((r) => setTimeout(() => r('still-blocked'), 600))
    ]);
    assert.equal(raced, 'still-blocked');

    lock.release();
    assert.equal(existsSync(`${cacheDir}.lock`), false);

    // Now the pending second acquire (250ms poll) can proceed.
    const lock2 = await second;
    assert.ok(lock2);
    lock2.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireSkillCacheLock: steals a stale (old-timestamp) lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lock-stale-'));
  try {
    const cacheDir = join(dir, 'fp');
    // Live pid, but timestamp ~16min old → stale, must be stolen.
    const old = Date.now() - 16 * 60_000;
    writeFileSync(`${cacheDir}.lock`, `${process.pid}\n${old}\n`);
    const lock = await acquireSkillCacheLock(cacheDir);
    assert.ok(lock, 'stale lock stolen and re-acquired');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireSkillCacheLock: steals a lock held by a dead pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-lock-deadpid-'));
  try {
    const cacheDir = join(dir, 'fp');
    // Fresh timestamp but an almost-certainly-dead pid → stolen via pid check.
    writeFileSync(`${cacheDir}.lock`, `999999999\n${Date.now()}\n`);
    const lock = await acquireSkillCacheLock(cacheDir);
    assert.ok(lock, 'dead-pid lock stolen and re-acquired');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
