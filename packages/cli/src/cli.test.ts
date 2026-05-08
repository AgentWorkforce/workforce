import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_VERSION,
  CLEAN_IGNORED_PATTERNS,
  CREATE_SELECTOR,
  SKILL_INSTALL_IGNORED_PATTERNS,
  assertSafeRelativePath,
  buildRelayfileMountPatterns,
  buildMountGitExcludeBlock,
  buildSidecarBody,
  configureGitForMount,
  decideCleanMode,
  loadSidecarForSelection,
  parseAgentArgs,
  parseInstallArgs,
  parseCreateArgs,
  resolveSystemPromptPlaceholders,
  stripAgentFlag,
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

test('parseAgentArgs: --install-in-repo sets flag and preserves positional selector', () => {
  const { flags, positional } = parseAgentArgs(['--install-in-repo', 'posthog@best']);
  assert.equal(flags.installInRepo, true);
  assert.deepEqual(positional, ['posthog@best']);
});

test('parseAgentArgs: preserves trailing positionals after the selector', () => {
  const { flags, positional } = parseAgentArgs([
    '--install-in-repo',
    'review@best-value',
    'extra-arg'
  ]);
  assert.equal(flags.installInRepo, true);
  assert.deepEqual(positional, ['review@best-value', 'extra-arg']);
});

test('parseAgentArgs: no flags → installInRepo false', () => {
  const { flags, positional } = parseAgentArgs(['posthog']);
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['posthog']);
});

test('parseAgentArgs: -- stops flag parsing, positional args after are preserved', () => {
  const { flags, positional } = parseAgentArgs([
    '--',
    '--install-in-repo',
    'posthog'
  ]);
  // --install-in-repo AFTER `--` is positional, not a flag.
  assert.equal(flags.installInRepo, false);
  assert.deepEqual(positional, ['--install-in-repo', 'posthog']);
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
    const { flags, selector, inputValues } = parseCreateArgs(['--install-in-repo', '--to', 'user']);
    assert.equal(selector, CREATE_SELECTOR);
    assert.equal(flags.installInRepo, true);
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
    assert.throws(() => parseCreateArgs(['posthog']), /__exit_trap__:1/);
    assert.deepEqual(trap.exits, [1]);
    assert.match(trap.stderr, /create: unexpected argument "posthog"/);
    assert.match(trap.stderr, /always runs persona-maker@best/);
  } finally {
    trap.restore();
  }
});

test('parseCreateArgs: cwd-local workforce wins as the implicit create target', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-cwd-'));
  const prevCwd = process.cwd();
  try {
    const project = join(root, 'project');
    mkdirSync(join(project, '.agentworkforce', 'workforce'), { recursive: true });
    process.chdir(project);
    const { inputValues } = parseCreateArgs([]);
    assert.equal(
      inputValues.TARGET_DIR,
      join(process.cwd(), '.agentworkforce', 'workforce', 'personas')
    );
    assert.equal(inputValues.CREATE_MODE, 'local');
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCreateArgs: --save-default persists create target in source config', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-create-default-'));
  const workforceHome = join(root, 'home', '.agentworkforce', 'workforce');
  const prev = process.env.AGENT_WORKFORCE_HOME;
  process.env.AGENT_WORKFORCE_HOME = workforceHome;
  try {
    parseCreateArgs(['--to', 'user', '--save-default']);
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

test('decideCleanMode: codex never mounts', () => {
  // No sandbox mount support for codex; --install-in-repo is moot.
  assert.deepEqual(decideCleanMode('codex'), { useClean: false });
  assert.deepEqual(decideCleanMode('codex', true), { useClean: false });
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
      ...extraEnv,
      // Force any harness spawn to ENOENT so the run terminates quickly.
      PATH: '/nonexistent-path-for-test',
      POSTHOG_API_KEY: 'dummy'
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
    'posthog',
    'hello'
  ]);
  assert.match(stderr, /unexpected argument "hello"/);
  assert.equal(exitCode, 1);
});

test('main: --version prints the package version', async () => {
  const { stderr, stdout, exitCode } = await runCliCapturingStderr(['--version']);
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, `${CLI_VERSION}\n`);
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
  const baseRuntime = {
    harness: 'claude' as const,
    model: 'claude-3-5-sonnet',
    systemPrompt: 'You are a test persona.',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
  };
  const selection = {
    personaId: 'p',
    tier: 'best' as const,
    runtime: baseRuntime,
    skills: [],
    rationale: 'test',
    claudeMdContent: '# Inlined\n',
    claudeMdMode: 'overwrite' as const
  };
  const { sidecar } = loadSidecarForSelection(selection);
  assert.ok(sidecar);
  assert.equal(sidecar.mountFile, 'CLAUDE.md');
  assert.equal(sidecar.personaContent, '# Inlined\n');
  assert.equal(sidecar.mode, 'overwrite');

  // codex harness gets nothing
  const codexSelection = {
    ...selection,
    runtime: { ...baseRuntime, harness: 'codex' as const }
  };
  const out = loadSidecarForSelection(codexSelection);
  assert.equal(out.sidecar, undefined);
});

test('loadSidecarForSelection: opencode picks agentsMd, not claudeMd', () => {
  const selection = {
    personaId: 'p',
    tier: 'best' as const,
    runtime: {
      harness: 'opencode' as const,
      model: 'gpt-5.2',
      systemPrompt: 'X',
      harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
    },
    skills: [],
    rationale: 'test',
    claudeMdContent: '# claude\n',
    agentsMdContent: '# agents\n'
  };
  const { sidecar } = loadSidecarForSelection(selection);
  assert.equal(sidecar?.mountFile, 'AGENTS.md');
  assert.equal(sidecar?.personaContent, '# agents\n');
});

test('main: codex sessions never engage the sandbox mount', async () => {
  // npm-provenance-publisher@best runs on codex; codex has no sandbox mount
  // support, so the run continues down the non-mount spawn path (which then
  // fails to spawn codex because PATH is scrubbed). We should NEVER see a
  // "sandbox mount → …" line, which the mount branch emits before calling
  // launchOnMount.
  const { stderr } = await runCliCapturingStderr([
    'agent',
    'npm-provenance-publisher@best'
  ]);
  assert.ok(
    !/sandbox mount →/.test(stderr),
    `expected the mount branch to be skipped; saw stderr:\n${stderr}`
  );
});
