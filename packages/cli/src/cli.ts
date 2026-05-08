#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HARNESS_VALUES,
  PERSONA_TAGS,
  PERSONA_TIERS,
  personaCatalog,
  resolveSidecar,
  routingProfiles,
  useSelection,
  type Harness,
  type PersonaIntent,
  type PersonaMount,
  type PersonaSelection,
  type PersonaSpec,
  type PersonaTag,
  type PersonaTier,
  type SidecarMdMode
} from '@agentworkforce/workload-router';
import {
  buildInteractiveSpec,
  detectHarnesses,
  formatDropWarnings,
  MissingPersonaInputError,
  renderPersonaInputs,
  resolvePersonaInputs,
  resolveMcpServersLenient,
  resolveStringMapLenient,
  type HarnessAvailability,
  type InteractiveSpec
} from '@agentworkforce/harness-kit';
import { launchOnMount, readAgentDotfiles } from '@relayfile/local-mount';
import ora, { type Ora } from 'ora';
import {
  startLaunchMetadataRecording,
  type LaunchMetadataRun
} from './launch-metadata.js';
import {
  buildPersonaSourceDirectories,
  defaultCwdPersonaDir,
  loadLocalPersonas,
  loadPersonaSourceConfig,
  normalizePersonaDir,
  savePersonaSourceConfig,
  type PersonaSource
} from './local-personas.js';
import { installPersonas, type PersonaInstallResult } from './persona-install.js';
import { pickPersona, type PickCandidate, type PickResult } from './persona-picker.js';

const USAGE = `Usage: agentworkforce <command> [args...]

Commands:
  create [flags]     Opens persona-maker@best for creating a new
                      persona, with target path passed as persona inputs.
                      Flags:
                        --to <target>       Storage target: cwd, user, dir:n,
                                            library, or an explicit path.
                                            Default: cwd when
                                            .agentworkforce/workforce exists,
                                            otherwise config defaultCreateTarget,
                                            otherwise user.
                        --save-default      Persist --to as defaultCreateTarget in
                                            ~/.agentworkforce/workforce/config.json.
                        --install-in-repo   Same behavior as agent.
                        --no-launch-metadata
                                            Same behavior as agent.
  agent [flags] <persona>[@<tier>]
                      Run a persona. Tier one of: ${PERSONA_TIERS.join(' | ')}
                      (default: best-value). Drops into an interactive harness
                      session.

                      Flags:
                        --install-in-repo   Disengage the sandbox mount and
                                            install skills into the repo's
                                            harness-conventional directory
                                            (.claude/skills, .opencode/skills,
                                            .agents/skills, etc.). By default,
                                            interactive claude and opencode
                                            sessions run inside a
                                            @relayfile/local-mount sandbox so
                                            npx prpm install / npx skills add
                                            writes never touch the real repo
                                            and CLAUDE.md / .claude / .mcp.json
                                            are hidden from the session. Codex
                                            sessions never mount and ignore
                                            this flag.
                        --no-launch-metadata
                                            Disable launch metadata recording.
                                            Also disabled by
                                            AGENTWORKFORCE_LAUNCH_METADATA=0.
  list [flags]        List available personas from the cascade (cwd →
                      configured persona dirs → library). By default shows
                      one row per persona at the recommended tier for its
                      intent; pass --all to see every tier. Flags:
                        --all                         show every tier (overrides default)
                        --json                        emit JSON instead of a table
                        --filter-rating <tier>        only show this tier; disables
                                                      the recommended-only default
                                                      (${PERSONA_TIERS.join(' | ')})
                        --filter-harness <harness>    only show this harness
                                                      (${HARNESS_VALUES.join(' | ')})
                        --filter-tag <tag>            only show personas carrying this tag
                                                      (${PERSONA_TAGS.join(' | ')})
                        --no-display-description      hide the DESCRIPTION column
  show <persona>[@<tier>]
                      Print the fully-resolved spec for a single persona,
                      including which cascade layer defined it (cwd, user,
                      dir:<n>, library). By default shows only the recommended
                      tier for the persona's intent; pass @<tier> to pick one,
                      or --all to see every tier. Flags:
                        --all         include every tier (overrides default)
                        --json        emit the resolved PersonaSpec as JSON
  install [flags] <pkg|path>
                      Copy persona JSON files from an npm package or local
                      package directory into
                      <cwd>/.agentworkforce/workforce/personas/. Flags:
                        --persona <id>  install only the matching persona id;
                                        repeat to install multiple
                        --overwrite     replace existing target files
  sources list [--json]
                      List persona source directories in cascade order.
  sources add <dir> [--position <n>]
                      Add a configurable persona source directory. Position is
                      1-based among configurable dirs after the fixed cwd dir.
  sources remove <dir|n>
                      Remove a configurable persona source directory by path or
                      1-based configurable position.
  harness check       Probe which harnesses (claude, codex, opencode) are
                      installed and runnable on this machine.
  pick "<task>"       Pick the best-fit persona for a free-text task description
                      using a cheap LLM call (Claude Haiku via the local
                      \`claude\` CLI). Prints the matched persona id to stdout
                      on success. On low confidence, prompts (TTY) to launch
                      persona-maker with the task as input, or exits non-zero
                      (non-TTY) with a hint.
                      Exit codes: 0 match, 2 no match, 3 picker unavailable.

Options:
  -h, --help          Show this help text.
  -v, --version       Print the agentworkforce version.

Local personas cascade: <cwd>/.agentworkforce/workforce/personas/*.json → configured persona dirs → repo library.
Each layer only needs to specify fields it overrides; everything else inherits
from the next lower layer. "extends" explicitly names a base; omit it and the
loader implicitly inherits from the same-id persona below. By default the only
configured persona dir is ~/.agentworkforce/workforce/personas.

Examples:
  agentworkforce create
  agentworkforce create --to user
  agentworkforce agent npm-provenance-publisher@best
  agentworkforce agent my-posthog@best
  agentworkforce agent review@best-value
  agentworkforce list
  agentworkforce show posthog
  agentworkforce install @agentrelay/personas --persona relay-orchestrator
  agentworkforce install ./local-personas --overwrite
  agentworkforce sources list
  agentworkforce sources add ../my-personas --position 1
  agentworkforce harness check
  agentworkforce pick "review this PR for security issues"
  agentworkforce agent "$(agentworkforce pick "fix the flaky test in foo.test.ts")"
`;

function die(msg: string, withUsage = true): never {
  process.stderr.write(`${msg}\n`);
  if (withUsage) process.stderr.write(`\n${USAGE}`);
  process.exit(1);
}

function readPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('Could not read @agentworkforce/cli package version.');
  }
  return pkg.version;
}

export const CLI_VERSION = readPackageVersion();
export const CREATE_SELECTOR = 'persona-maker@best';

const CREATE_INPUT_TARGET_DIR = 'TARGET_DIR';
const CREATE_INPUT_CREATE_MODE = 'CREATE_MODE';

const local = loadLocalPersonas();
for (const warning of local.warnings) {
  process.stderr.write(`warning: ${warning}\n`);
}

type ResolvedTarget =
  | { kind: 'repo'; source: 'library'; spec: PersonaSpec; tier: PersonaTier }
  | { kind: 'local'; source: PersonaSource; spec: PersonaSpec; tier: PersonaTier };

function resolveSpec(key: string): ResolvedTarget['spec'] | { error: string } {
  const localSpec = local.byId.get(key);
  if (localSpec) return localSpec;
  const catalogAsIntent = (personaCatalog as Record<string, PersonaSpec>)[key];
  if (catalogAsIntent) return catalogAsIntent;
  const byId = Object.values(personaCatalog).find((p) => p.id === key);
  if (byId) return byId;

  const repoListing = Object.values(personaCatalog)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `  ${p.id}  (intent: ${p.intent})`);
  const localListing = [...local.byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `  ${p.id}  (${local.sources.get(p.id) ?? 'local'})`);
  const listing = [...repoListing, ...localListing].join('\n');
  return { error: `Unknown persona "${key}". Known personas:\n${listing}` };
}

function parseSelector(sel: string): ResolvedTarget {
  const at = sel.indexOf('@');
  const key = at === -1 ? sel : sel.slice(0, at);
  const tierRaw = at === -1 ? undefined : sel.slice(at + 1);
  if (!key) die('Missing persona name before "@"');
  const tier = (tierRaw ?? 'best-value') as PersonaTier;
  if (tierRaw !== undefined && !PERSONA_TIERS.includes(tier)) {
    die(`Invalid tier "${tierRaw}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
  }
  const result = resolveSpec(key);
  if ('error' in result) die(result.error, false);
  const kind = local.byId.has(key) ? 'local' : 'repo';
  if (kind === 'local') {
    return { kind, source: local.sources.get(result.id) ?? 'cwd', spec: result, tier };
  }
  return { kind, source: 'library', spec: result, tier };
}

/**
 * Resolve the `<harness>` placeholder used in persona systemPrompts.
 * Personas embed `<harness>` inside example install commands (e.g.
 * `npx prpm install <ref> --as <harness>`) so the docstring stays
 * harness-agnostic in source. The active harness is known at selection
 * time, so swap it in here to give the model a concrete command.
 *
 * Exported for test coverage. Only `<harness>` is resolved today; other
 * angle-bracketed tokens in the prompt (e.g. `<ref>`, `<repo-url>`,
 * `<query>`) are deliberately left as LLM-facing placeholders.
 */
export function resolveSystemPromptPlaceholders(prompt: string, harness: Harness): string {
  return prompt.replaceAll('<harness>', harness);
}

function buildSelection(spec: PersonaSpec, tier: PersonaTier, kind: 'repo' | 'local'): PersonaSelection {
  const rawRuntime = spec.tiers[tier];
  const runtime = {
    ...rawRuntime,
    systemPrompt: resolveSystemPromptPlaceholders(rawRuntime.systemPrompt, rawRuntime.harness)
  };
  const sidecar = resolveSidecar(spec, tier);
  return {
    personaId: spec.id,
    tier,
    runtime,
    skills: spec.skills,
    rationale: kind === 'local' ? `local-override: ${spec.id}` : `cli-tier-override: ${tier}`,
    ...(spec.inputs ? { inputs: spec.inputs } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.mount ? { mount: spec.mount } : {}),
    ...(sidecar.claudeMd ? { claudeMd: sidecar.claudeMd } : {}),
    ...(sidecar.claudeMdContent ? { claudeMdContent: sidecar.claudeMdContent } : {}),
    ...(sidecar.claudeMd || sidecar.claudeMdContent
      ? { claudeMdMode: sidecar.claudeMdMode }
      : {}),
    ...(sidecar.agentsMd ? { agentsMd: sidecar.agentsMd } : {}),
    ...(sidecar.agentsMdContent ? { agentsMdContent: sidecar.agentsMdContent } : {}),
    ...(sidecar.agentsMd || sidecar.agentsMdContent
      ? { agentsMdMode: sidecar.agentsMdMode }
      : {})
  };
}

function emitDropWarnings(lines: string[]): void {
  if (lines.length === 0) return;
  for (const line of lines) process.stderr.write(`warning: ${line}\n`);
  process.stderr.write(
    `        (referenced env vars were not set — proceeding without those values; if the agent relies on them it may need to authenticate interactively, e.g. via OAuth.)\n`
  );
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 0;
  const num = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (num ?? 1);
}

/**
 * Derive a meaningful exit code from a `spawnSync` result. `spawnSync`
 * sets `status` to null and `signal` to the signal name (e.g. `SIGINT`)
 * when the child was killed before it could set its own exit code, so
 * a naive `res.status ?? 1` collapses Ctrl-C / SIGTERM onto generic
 * failure instead of the conventional 128+N.
 */
function subprocessExitCode(res: ReturnType<typeof spawnSync>): number {
  if (res.status !== null) return res.status;
  if (res.signal) return signalExitCode(res.signal);
  return 1;
}

function runInstall(command: readonly string[], label: string, cwd?: string): void {
  const [bin, ...args] = command;
  if (!bin) return;
  process.stderr.write(`• ${label}\n`);
  const res = spawnSync(bin, args, { stdio: 'inherit', shell: false, ...(cwd ? { cwd } : {}) });
  const code = subprocessExitCode(res);
  if (code !== 0) {
    process.stderr.write(`${label} failed (exit ${code}). Aborting.\n`);
    process.exit(code);
  }
}

/**
 * Thrown by `runInstallOrThrow` when the install subprocess exits non-zero.
 * Carries the underlying exit code so the mount-branch catch can surface it
 * to the user instead of collapsing every failure onto 127.
 */
class InstallCommandError extends Error {
  readonly exitCode: number;
  constructor(label: string, exitCode: number) {
    super(`${label} failed (exit ${exitCode})`);
    this.name = 'InstallCommandError';
    this.exitCode = exitCode;
  }
}

/**
 * Install variant that throws instead of calling `process.exit` on failure.
 * Used inside `launchOnMount`'s `onBeforeLaunch`, so mount teardown runs
 * before the error surfaces.
 */
function runInstallOrThrow(command: readonly string[], label: string, cwd: string): void {
  const [bin, ...args] = command;
  if (!bin) return;
  process.stderr.write(`• ${label}\n`);
  const res = spawnSync(bin, args, { stdio: 'inherit', shell: false, cwd });
  const code = subprocessExitCode(res);
  if (code !== 0) {
    throw new InstallCommandError(label, code);
  }
}

function runCleanup(command: readonly string[], commandString: string): void {
  if (commandString === ':') return;
  const [bin, ...args] = command;
  if (!bin) return;
  spawnSync(bin, args, { stdio: 'inherit', shell: false });
}

/**
 * Remove the whole per-session directory after the run, including the
 * enclosing `<homedir>/.agent-workforce/sessions/<id>/` that the CLI
 * created. The workload-router cleanup only covers the install subtree
 * (`<root>/claude/plugin`), so without this step empty parent dirs
 * would accumulate under `~/.agent-workforce/sessions/`.
 *
 * Uses `fs.rmSync` rather than `spawnSync('rm', …)` so the teardown works
 * on Windows where `rm` isn't on PATH.
 */
function removeSessionRoot(sessionRoot: string | undefined): void {
  if (!sessionRoot) return;
  try {
    rmSync(sessionRoot, { recursive: true, force: true });
  } catch {
    /* best-effort — if teardown fails the dir is harmless under ~/.agent-workforce/sessions */
  }
}

/**
 * Compute the absolute root directory for an interactive claude session.
 * Layout (under `root`):
 *
 *   ~/.agent-workforce/sessions/<personaId>-<timestamp>-<rand>/
 *     ├── claude/plugin/     ← skill install target + --plugin-dir
 *     └── mount/             ← @relayfile/local-mount mount
 *
 * The timestamp + random suffix keep concurrent sessions from colliding on
 * the same dir. Both the skill-install path and the mount path are derived
 * from the same `root` so a single session ID describes the whole run.
 */
function generateSessionRoot(personaId: string): string {
  const sessionId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return join(homedir(), '.agent-workforce', 'sessions', `${personaId}-${sessionId}`);
}

function sessionInstallRoot(sessionRoot: string): string {
  return join(sessionRoot, 'claude', 'plugin');
}

function sessionMountDir(sessionRoot: string): string {
  return join(sessionRoot, 'mount');
}

/**
 * Remove every `--agent <id>` pair from a harness argv. Used on the non-mount
 * opencode path where we cannot safely materialize the persona's
 * opencode.json (it would land in the user's real repo), so we fall back to
 * launching opencode without a persona-specific agent selection.
 *
 * Strips all occurrences rather than just the first — the current producer
 * (harness-kit's opencode branch) emits exactly one pair, so both behaviors
 * are equivalent today, but "remove all" is idempotent and safer if a future
 * caller ever appends a second `--agent` for any reason. A trailing `--agent`
 * with no following value is preserved so the malformed argv surfaces at the
 * harness rather than getting silently swallowed here.
 */
export function stripAgentFlag(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--agent' && i + 1 < args.length) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Validate that a configFile's relative path is safe to resolve under a
 * sandbox/session directory. Rejects absolute paths and any segment equal to
 * `..` so a malformed or adversarial persona cannot escape the mount via
 * `join()` and overwrite files elsewhere. Called at materialization time so
 * the failure surfaces with a clear path before any disk write happens.
 */
export function assertSafeRelativePath(relPath: string): void {
  if (!relPath) {
    throw new Error('configFile path must be a non-empty relative path');
  }
  if (isAbsolute(relPath)) {
    throw new Error(
      `configFile path must be relative; got absolute path ${JSON.stringify(relPath)}`
    );
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error(
      `configFile path must not contain ".." segments; got ${JSON.stringify(relPath)}`
    );
  }
}

/** Patterns hidden from an interactive claude session by the sandbox mount.
 * Applied by `@relayfile/local-mount` with gitignore semantics, so bare names
 * match at any depth in the project tree (e.g. `.claude` hides both
 * `./.claude/` and `./packages/foo/.claude/`). */
export const CLEAN_IGNORED_PATTERNS = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude',
  '.mcp.json',
  // Per-persona AGENTS.md sidecars get materialized into the mount when
  // running under opencode; without this the user's real-cwd AGENTS.md
  // would copy in (masking the persona content) and writes from
  // onBeforeLaunch would sync back out.
  'AGENTS.md'
] as const;

/**
 * Skill-install artifacts that should never be copied into the mount nor
 * synced back to the real repo. Applied to non-claude interactive sessions
 * that rely on the mount to keep `npx skills add` / `npx prpm install`
 * writes out of the user's project tree. Covers every per-provider output
 * root that skill.sh / prpm scatter into on install — missing one here
 * re-introduces repo pollution, so this list is deliberately superset-y.
 * Claude sessions use `installRoot` for out-of-repo staging instead, so
 * these patterns don't apply there.
 */
export const SKILL_INSTALL_IGNORED_PATTERNS = [
  // skill.sh universal install root + per-harness symlink farms
  '.agents',
  '.claude/skills',
  '.factory/skills',
  '.kiro/skills',
  'skills',
  // prpm `--as <harness>` output roots
  '.opencode',
  '.skills',
  // provider lockfiles written at the repo root
  'prpm.lock',
  'skills-lock.json',
  // Per-persona AGENTS.md sidecars (opencode harness) get materialized
  // into the mount; hide so the real-cwd AGENTS.md isn't copied in and
  // the persona-written copy doesn't sync back out.
  'AGENTS.md'
] as const;

export interface RelayfileMountPatterns {
  ignoredPatterns: string[];
  readonlyPatterns: string[];
}

export function buildRelayfileMountPatterns(input: {
  projectDir: string;
  personaId: string;
  harness: Harness;
  mount?: PersonaMount;
  configFilePaths?: readonly string[];
}): RelayfileMountPatterns {
  const dotfiles = readAgentDotfiles(input.projectDir, {
    agentName: input.personaId
  });
  const builtInIgnored =
    input.harness === 'claude'
      ? CLEAN_IGNORED_PATTERNS
      : SKILL_INSTALL_IGNORED_PATTERNS;

  return {
    ignoredPatterns: [
      ...dotfiles.ignoredPatterns,
      ...(input.mount?.ignoredPatterns ?? []),
      ...builtInIgnored,
      ...(input.configFilePaths ?? [])
    ],
    readonlyPatterns: [
      ...dotfiles.readonlyPatterns,
      ...(input.mount?.readonlyPatterns ?? [])
    ]
  };
}

/**
 * Build the block appended to `<mount>/.git/info/exclude` so untracked-and-
 * hidden files (e.g. `.claude/skills/` materialized by skill installs, or
 * `opencode.json` written by `onBeforeLaunch`) don't surface under
 * "Untracked files" in `git status` inside the mount.
 *
 * Exported pure helper for unit-testing the formatting separately from the
 * disk-writing wrapper below.
 */
export function buildMountGitExcludeBlock(patterns: readonly string[]): string {
  const lines = [
    '',
    '# agentworkforce: patterns hidden from this sandboxed session.',
    '# Tracked paths matching these patterns are also marked skip-worktree',
    '# so `git status` does not report them as deleted.',
    ...patterns,
    ''
  ];
  return lines.join('\n');
}

/**
 * Configure the mount's per-session `.git` so paths hidden by the relayfile
 * mount don't show as deleted/untracked inside the sandbox.
 *
 * - Appends `patterns` to `.git/info/exclude` so untracked-and-hidden files
 *   don't show up under "Untracked files".
 * - Marks every tracked file matching one of the patterns as skip-worktree
 *   so `git status` doesn't list it as deleted (the work tree omits it on
 *   purpose, not by user action).
 *
 * Best-effort: if the mount has no `.git` (project isn't a repo, or
 * `includeGit: false`) or any git command fails, returns silently. The
 * mount's `.git` is per-session and `noSyncBack` per relayfile 0.6+, so
 * writes here are sandboxed and never leak to the user's main checkout.
 */
export function configureGitForMount(mountDir: string, patterns: readonly string[]): void {
  if (patterns.length === 0) return;
  const infoDir = join(mountDir, '.git', 'info');
  if (!existsSync(infoDir)) return;

  appendFileSync(join(infoDir, 'exclude'), buildMountGitExcludeBlock(patterns));

  // Use git's own gitignore matcher to pick which tracked files to flag,
  // keeping semantics aligned with relayfile's (gitignore-style, basename-
  // anywhere) filter. `--cached -i --exclude-from=<file>` (without
  // `--exclude-standard`) lists only tracked files matched by the supplied
  // patterns — not the repo's own .gitignore.
  const tmpExcludes = join(infoDir, '.aw-skip-list');
  try {
    writeFileSync(tmpExcludes, patterns.join('\n') + '\n');
    const ls = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '-i', `--exclude-from=${tmpExcludes}`],
      { cwd: mountDir }
    );
    if (ls.status !== 0) return;
    const files = ls.stdout.toString('utf8').split('\0').filter(Boolean);
    if (files.length === 0) return;
    // Chunk to stay well under typical argv-length limits on huge repos.
    const CHUNK = 200;
    for (let i = 0; i < files.length; i += CHUNK) {
      spawnSync(
        'git',
        ['update-index', '--skip-worktree', '--', ...files.slice(i, i + CHUNK)],
        { cwd: mountDir }
      );
    }
  } finally {
    try {
      rmSync(tmpExcludes, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Persona-supplied sidecar markdown materialized into a sandbox mount.
 * Pure data carrier — `runInteractive` translates it into the on-disk
 * write inside `onBeforeLaunch` (mount path) and warns/skips when the
 * harness has no mount (codex / `--install-in-repo`).
 */
export interface ResolvedSidecar {
  /** Filename inside the mount: `CLAUDE.md` (claude) or `AGENTS.md` (opencode). */
  mountFile: 'CLAUDE.md' | 'AGENTS.md';
  /** Persona-author content. Already inlined for built-ins; read from disk for local. */
  personaContent: string;
  mode: SidecarMdMode;
}

/**
 * Resolve the sidecar for a given selection + harness, returning the
 * persona-author content the runtime should materialize into the mount.
 * Returns `{}` when no sidecar applies (no path/content set, or harness
 * doesn't support sidecar files at all). Read errors surface as a warning
 * string so the caller can drop the sidecar gracefully rather than
 * failing the whole session.
 */
export function loadSidecarForSelection(
  selection: PersonaSelection
): { sidecar?: ResolvedSidecar; warning?: string } {
  const harness = selection.runtime.harness;
  if (harness !== 'claude' && harness !== 'opencode') return {};
  if (harness === 'claude') {
    if (selection.claudeMdContent) {
      return {
        sidecar: {
          mountFile: 'CLAUDE.md',
          personaContent: selection.claudeMdContent,
          mode: selection.claudeMdMode ?? 'overwrite'
        }
      };
    }
    if (selection.claudeMd) {
      try {
        const content = readFileSync(selection.claudeMd, 'utf8');
        return {
          sidecar: {
            mountFile: 'CLAUDE.md',
            personaContent: content,
            mode: selection.claudeMdMode ?? 'overwrite'
          }
        };
      } catch (err) {
        return { warning: `claudeMd: could not read ${selection.claudeMd}: ${(err as Error).message}` };
      }
    }
    return {};
  }
  if (selection.agentsMdContent) {
    return {
      sidecar: {
        mountFile: 'AGENTS.md',
        personaContent: selection.agentsMdContent,
        mode: selection.agentsMdMode ?? 'overwrite'
      }
    };
  }
  if (selection.agentsMd) {
    try {
      const content = readFileSync(selection.agentsMd, 'utf8');
      return {
        sidecar: {
          mountFile: 'AGENTS.md',
          personaContent: content,
          mode: selection.agentsMdMode ?? 'overwrite'
        }
      };
    } catch (err) {
      return { warning: `agentsMd: could not read ${selection.agentsMd}: ${(err as Error).message}` };
    }
  }
  return {};
}

/**
 * Compute the bytes to write into the mount for a sidecar. In `extend`
 * mode, prepends the user's real-cwd file (if any) joined to the persona
 * content with `\n\n---\n\n`. Pure — exposed for unit tests.
 */
export function buildSidecarBody(
  sidecar: ResolvedSidecar,
  realCwdDir: string
): string {
  if (sidecar.mode === 'extend') {
    const realPath = join(realCwdDir, sidecar.mountFile);
    try {
      const realContent = readFileSync(realPath, 'utf8');
      return `${realContent}\n\n---\n\n${sidecar.personaContent}`;
    } catch (err) {
      // Only "missing path" errors degrade to overwrite. Real I/O
      // problems (EACCES, EISDIR, …) propagate so callers see them
      // instead of silently dropping the user's CLAUDE.md/AGENTS.md.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return sidecar.personaContent;
      }
      throw err;
    }
  }
  return sidecar.personaContent;
}

/**
 * Decide whether to run the interactive session inside a
 * `@relayfile/local-mount` sandbox.
 *
 * - Claude / opencode: mount engages by default. Hides CLAUDE.md / .claude
 *   / .mcp.json (claude) and routes `npx prpm install` / `npx skills add`
 *   writes (both) into the sandbox. Disengage with `--install-in-repo`.
 * - Codex: no sandbox mount support, always runs against the real cwd.
 *
 * Pure — no side effects, trivially testable.
 */
export function decideCleanMode(
  harness: Harness,
  installInRepo = false
): { useClean: boolean } {
  if (harness === 'claude' || harness === 'opencode') {
    return { useClean: !installInRepo };
  }
  return { useClean: false };
}

async function runInteractive(
  selection: PersonaSelection,
  options: {
    installInRepo?: boolean;
    noLaunchMetadata?: boolean;
    personaSpec: PersonaSpec;
    personaSource: PersonaSource;
  }
): Promise<number> {
  const inputResolution = resolvePersonaInputs(
    selection.inputs,
    selection.inputValues,
    process.env
  );
  const renderedSystemPrompt = renderPersonaInputs(
    selection.runtime.systemPrompt,
    inputResolution.values
  );
  const effectiveSelection: PersonaSelection = {
    ...selection,
    runtime: {
      ...selection.runtime,
      systemPrompt: renderedSystemPrompt
    }
  };
  const { runtime, personaId, tier } = effectiveSelection;
  // `installRoot` (out-of-repo skill staging via `--plugin-dir`) is currently
  // claude-only; the workload-router SDK throws if it's set for other
  // harnesses. For opencode, we instead keep installs out of the repo by
  // running them inside a @relayfile/local-mount sandbox (see `useClean`
  // below). The --install-in-repo flag forces legacy in-repo installs
  // across the board.
  const useClean = decideCleanMode(
    runtime.harness,
    options.installInRepo === true
  ).useClean;
  // Per-persona CLAUDE.md / AGENTS.md: load the author content if any. The
  // file is materialized into the mount inside onBeforeLaunch (claude/
  // opencode default). Without a mount (codex, --install-in-repo) we
  // skip-and-warn — writing into the real cwd would pollute the user's
  // repo and is explicitly out of scope.
  const sidecarLookup = loadSidecarForSelection(effectiveSelection);
  if (sidecarLookup.warning) {
    process.stderr.write(`warning: ${sidecarLookup.warning}\n`);
  }
  const resolvedSidecar = useClean ? sidecarLookup.sidecar : undefined;
  if (sidecarLookup.sidecar && !useClean) {
    process.stderr.write(
      `warning: persona declares ${sidecarLookup.sidecar.mountFile} but no sandbox mount is available (` +
        `${runtime.harness === 'codex' ? 'codex harness has no mount' : '--install-in-repo disengages the mount'})` +
        `; skipping sidecar materialization to avoid writing into your repo.\n`
    );
  }
  // A session dir is needed whenever we either (a) stage skills out-of-repo
  // via claude's installRoot, or (b) open a mount. Both engage for claude/
  // opencode by default; --install-in-repo disengages both.
  const useSessionDir =
    !options.installInRepo && (runtime.harness === 'claude' || useClean);
  const sessionRoot = useSessionDir ? generateSessionRoot(personaId) : undefined;
  const installRoot =
    sessionRoot && runtime.harness === 'claude'
      ? sessionInstallRoot(sessionRoot)
      : undefined;
  const ctx = useSelection(
    effectiveSelection,
    installRoot !== undefined ? { installRoot } : {}
  );
  const { install } = ctx;
  process.stderr.write(`→ ${personaId} [${tier}] via ${runtime.harness} (${runtime.model})\n`);

  const startLaunchMetadataForLaunch = (cwd = process.cwd()) =>
    startLaunchMetadataRecording({
      selection: effectiveSelection,
      personaSpec: options.personaSpec,
      personaSource: options.personaSource,
      cwd,
      noLaunchMetadata: options.noLaunchMetadata,
      env: process.env
    });

  const inputEnv = inputResolution.values;
  const callerEnv = { ...process.env, ...inputEnv };
  const envResolution = resolveStringMapLenient(effectiveSelection.env, callerEnv, 'env');
  const mcpResolution = resolveMcpServersLenient(effectiveSelection.mcpServers, callerEnv);
  emitDropWarnings(
    formatDropWarnings(envResolution.dropped, mcpResolution.dropped, mcpResolution.droppedServers)
  );
  const resolvedEnv =
    Object.keys(inputEnv).length > 0 || envResolution.value
      ? { ...(envResolution.value ?? {}), ...inputEnv }
      : undefined;
  const resolvedMcp = mcpResolution.servers;

  // In session mode the install command is never `:` — it at minimum runs
  // the plugin scaffold (mkdir + manifest + symlink) so `--plugin-dir` has a
  // valid target even for skill-less personas like posthog. Gate on the
  // command string rather than `installs.length` so we don't skip that.
  const skillIds = install.plan.installs.map((i) => i.skillId).join(', ');
  const installLabel =
    install.plan.installs.length === 0
      ? `Staging session plugin dir${installRoot ? ` → ${installRoot}` : ''}`
      : `Installing skills: ${skillIds}${installRoot ? ` → ${installRoot}` : ''}`;
  // When useClean engages on a non-claude harness, the install must run
  // INSIDE the mount so `.opencode/skills/`, `.agents/skills/`, prpm.lock,
  // etc. land in the sandbox rather than the real repo. We defer it to
  // `onBeforeLaunch` below instead of pre-running here.
  const deferInstallToMount =
    useClean && runtime.harness !== 'claude' && install.commandString !== ':';
  if (install.commandString !== ':' && !deferInstallToMount) {
    runInstall(install.command, installLabel);
  }

  const spec = buildInteractiveSpec({
    harness: runtime.harness,
    personaId,
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    mcpServers: resolvedMcp,
    permissions: effectiveSelection.permissions,
    ...(installRoot !== undefined ? { pluginDirs: [installRoot] } : {})
  });
  for (const w of spec.warnings) process.stderr.write(`warning: ${w}\n`);

  // Config-file materialization strategy:
  //  - Mount path (claude/opencode default): write each configFile into the
  //    mount dir via onBeforeLaunch, so it lives only in the sandbox and is
  //    torn down with the session.
  //  - Non-mount path: today the only configFile producer is opencode
  //    (opencode.json for the --agent wiring), and the non-mount opencode
  //    path only engages under --install-in-repo. Writing opencode.json
  //    into the user's real repo would pollute the working tree, so we
  //    degrade: drop --agent from the argv, warn, and launch opencode with
  //    its default agent. The persona's prompt will not be applied in that
  //    mode; users who want it should drop --install-in-repo (the mount
  //    default handles this cleanly).
  const hasConfigFiles = spec.configFiles.length > 0;
  const degradeConfigFiles = hasConfigFiles && !useClean;
  let effectiveArgs: readonly string[] = spec.args;
  if (degradeConfigFiles) {
    process.stderr.write(
      'warning: --install-in-repo cannot safely materialize the persona agent config (would write opencode.json into your repo); launching without --agent. Drop --install-in-repo to apply the persona prompt.\n'
    );
    effectiveArgs = stripAgentFlag(spec.args);
  }
  const finalArgs = spec.initialPrompt ? [...effectiveArgs, spec.initialPrompt] : [...effectiveArgs];

  // Print a sanitized summary rather than raw argv: spec.args for the claude
  // harness contains the resolved --mcp-config JSON and the full system
  // prompt, either of which can carry secrets (Bearer tokens, API keys) once
  // env refs are interpolated. We show the bin, model, and the *names* of
  // the servers / permission fields so the user can verify the shape without
  // leaking credentials to stderr or CI logs.
  const summary: string[] = [`model=${runtime.model}`];
  if (runtime.harness === 'claude') {
    const servers = Object.keys(resolvedMcp ?? {});
    summary.push(`mcp-strict=${servers.length ? servers.join(',') : '(none)'}`);
    if (effectiveSelection.permissions?.allow?.length) {
      summary.push(`allow=${effectiveSelection.permissions.allow.length} rule(s)`);
    }
    if (effectiveSelection.permissions?.deny?.length) {
      summary.push(`deny=${effectiveSelection.permissions.deny.length} rule(s)`);
    }
    if (effectiveSelection.permissions?.mode) {
      summary.push(`mode=${effectiveSelection.permissions.mode}`);
    }
  }
  if (spec.initialPrompt) summary.push('initial-prompt=<systemPrompt>');
  if (useClean) summary.push('mount=on');
  process.stderr.write(`• spawning ${spec.bin} (${summary.join(', ')})\n`);

  // Mount branch: delegate process lifecycle (spawn, signal forwarding,
  // syncback, cleanup) to @relayfile/local-mount.
  //
  // For claude and opencode: mount engages by default (unless
  // `--install-in-repo`). For claude this hides CLAUDE.md / .claude /
  // .mcp.json; for opencode it routes `npx prpm install` / `npx skills
  // add` writes into the sandbox (skill plugin dir for claude lives
  // outside the mount at an absolute path, so claude still resolves
  // `--plugin-dir` normally).
  //
  // The install itself runs inside the mount via `onBeforeLaunch` so that
  // `npx prpm install` / `npx skills add` writes land in the sandbox. The
  // skill-install paths are added to `ignoredPatterns` so they are neither
  // copied in from the real repo nor synced back on exit.
  if (useClean && sessionRoot) {
    const mountDir = sessionMountDir(sessionRoot);
    let launchMetadata: LaunchMetadataRun | undefined;
    // Anything we materialize into the mount via onBeforeLaunch must be
    // hidden from the mount-mirror in both directions: without this, any
    // opencode.json already present in the real repo would be copied into
    // the mount (masking the per-session agent config we write), and the
    // fresh write from onBeforeLaunch would sync back out on exit and
    // pollute the user's working tree. Added dynamically so this stays
    // generic for any future configFile producer.
    const { ignoredPatterns, readonlyPatterns } = buildRelayfileMountPatterns({
      projectDir: process.cwd(),
      personaId,
      harness: runtime.harness,
      mount: effectiveSelection.mount,
      configFilePaths: spec.configFiles.map((file) => file.path)
    });
    process.stderr.write(`• sandbox mount → ${mountDir}\n`);
    // Three-stage SIGINT handler layered on top of launchOnMount's own signal
    // forwarding. launchOnMount catches the first SIGINT to kill the child
    // and run its finalize() (autoSync.stop + final syncBack), which walks
    // both trees and can take several seconds on a large repo — during
    // which the terminal otherwise looks frozen.
    //
    //   1st press  → start an ora spinner so the pause is visibly live
    //                (replaces the prior static print). onAfterSync below
    //                transitions the spinner into a succeed/fail state once
    //                relayfile reports the sync result.
    //   2nd press  → update the spinner text to the "aborting" warning and
    //                abort `shutdownSignal`, which local-mount 0.5+ respects
    //                by skipping autosync's draining reconcile and returning
    //                the partial count from the final syncBack. Cleanup
    //                still runs, so no leaked mount dir.
    //   3rd press  → hard escape: synchronously rm the mount root and
    //                process.exit(130) in case the abort never resolves.
    const shutdownController = new AbortController();
    let sigintCount = 0;
    let syncSpinner: Ora | undefined;
    const forceExitHandler = () => {
      sigintCount += 1;
      if (sigintCount === 1) {
        syncSpinner = ora({
          text: 'Syncing session changes back to the repo… (Ctrl-C again to skip)',
          stream: process.stderr
        }).start();
        return;
      }
      if (sigintCount === 2) {
        if (syncSpinner) {
          syncSpinner.text =
            'Aborting sync — partial changes will be propagated. (Ctrl-C again to force quit)';
        }
        shutdownController.abort();
        return;
      }
      if (syncSpinner) {
        syncSpinner.fail('Force-quit: mount teardown skipped. Session dir may be left behind.');
        syncSpinner = undefined;
      } else {
        process.stderr.write(
          '\n✗ Force-quit: mount teardown skipped. Session dir may be left behind.\n'
        );
      }
      // Node-native removal rather than `rm -rf` so the emergency path
      // works on Windows too.
      try {
        rmSync(sessionRoot, { recursive: true, force: true });
      } catch {
        /* swallow — we're exiting anyway */
      }
      process.exit(130);
    };
    process.on('SIGINT', forceExitHandler);
    try {
      const result = await launchOnMount({
        cli: spec.bin,
        projectDir: process.cwd(),
        mountDir,
        args: finalArgs,
        ignoredPatterns,
        // launchOnMount passes `env` straight to the child spawn, so without
        // merging process.env we'd strip PATH/HOME/etc. Match the non-clean
        // branch: persona env overlays the inherited environment.
        env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env,
        agentName: personaId,
        // Pull `.git` into the mount so git commands work inside the
        // sandbox. relayfile 0.6+ treats this as a one-way project→mount
        // sync: host-side `.git` changes propagate in, mount-side commits/
        // refs stay sandboxed and are discarded on cleanup. The agent must
        // `git push` to persist work — local-only commits evaporate with
        // the session.
        includeGit: true,
        readonlyPatterns,
        // Second Ctrl-C aborts this signal → local-mount skips autosync's
        // draining reconcile and returns the partial syncBack count. Cleanup
        // still runs, so there's no leaked mount dir.
        shutdownSignal: shutdownController.signal,
        // Report sync stats so the user sees confirmation rather than a
        // silent pause between the child exiting and the CLI returning.
        //
        // NOTE: `count` is bidirectional per relayfile's onAfterSync
        // contract (see @relayfile/local-mount launch.d.ts) — it sums
        // autosync activity in *both* directions (inbound project→mount
        // and outbound mount→project, including deletes) plus the final
        // mount→project syncBack. Phrasing this as "synced back to the
        // repo" earlier misled sessions where inbound events dominated:
        // a user who did no edits still saw "Synced 15 changes back"
        // because ambient initial-mirror traffic counted. Phrase as "file
        // events during session" so we don't overclaim direction.
        onAfterSync: (count) => {
          const aborted = shutdownController.signal.aborted;
          const qualifier = aborted ? ' (partial)' : '';
          const message =
            count > 0
              ? `Session complete — ${count} file event${count === 1 ? '' : 's'} during session${qualifier}.`
              : 'Session complete — no file events.';
          if (syncSpinner) {
            syncSpinner.succeed(message);
            syncSpinner = undefined;
          } else {
            process.stderr.write(`✓ ${message}\n`);
          }
        },
        onBeforeLaunch: async (dir: string) => {
          // Run before install / configFile writes so the freshly written
          // files (e.g. `.opencode/`, `opencode.json`) aren't yet present
          // when we run `git ls-files` to pick skip-worktree candidates —
          // we don't need them flagged in the index, just hidden via the
          // `.git/info/exclude` block.
          configureGitForMount(dir, ignoredPatterns);
          if (deferInstallToMount) {
            runInstallOrThrow(install.command, installLabel, dir);
          }
          for (const file of spec.configFiles) {
            assertSafeRelativePath(file.path);
            const target = join(dir, file.path);
            // mkdir -p for any subdirs in file.path — the
            // InteractiveConfigFile contract allows nested relative
            // paths, and writeFileSync would otherwise throw ENOENT.
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, file.contents, 'utf8');
          }
          if (resolvedSidecar) {
            const body = buildSidecarBody(resolvedSidecar, process.cwd());
            writeFileSync(join(dir, resolvedSidecar.mountFile), body, 'utf8');
          }
          launchMetadata = await startLaunchMetadataForLaunch(dir);
        }
      });
      return result.exitCode;
    } catch (err) {
      // If the spinner is still live when we error out, mark it failed so
      // the pending animation doesn't hang around under the error message.
      if (syncSpinner) {
        syncSpinner.fail('Sync did not complete');
        syncSpinner = undefined;
      }
      // InstallCommandError carries the real install exit code — surfacing
      // it (rather than collapsing onto 127) lets callers distinguish a
      // failed `npx prpm install` from a missing harness binary.
      if (err instanceof InstallCommandError) {
        process.stderr.write(`${err.message}. Aborting.\n`);
        return err.exitCode;
      }
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        process.stderr.write(
          `Failed to spawn "${spec.bin}" inside sandbox mount: binary not found on PATH. Install the ${runtime.harness} CLI and retry.\n`
        );
        return 127;
      }
      process.stderr.write(`Failed to launch sandbox mount: ${e.message}\n`);
      return 1;
    } finally {
      // Defensive: if neither onAfterSync nor the catch branch stopped the
      // spinner (e.g. unexpected exit path), stop it cleanly here so the
      // terminal is not left in spinner state.
      if (syncSpinner) {
        syncSpinner.stop();
        syncSpinner = undefined;
      }
      await launchMetadata?.stop();
      process.removeListener('SIGINT', forceExitHandler);
      // When the install ran inside the mount, its cleanup paths are
      // mount-relative (e.g. `.skills/<name>`, `skills/<name>`) and
      // running cleanup here would resolve them against the real repo
      // cwd — potentially `rm -rf`ing pre-existing user content. The
      // mount dir is removed wholesale by `removeSessionRoot` below, so
      // the install's cleanup is redundant anyway in that case.
      if (!deferInstallToMount) {
        runCleanup(install.cleanupCommand, install.cleanupCommandString);
      }
      removeSessionRoot(sessionRoot);
    }
  }

  const launchMetadata = await startLaunchMetadataForLaunch();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      runCleanup(install.cleanupCommand, install.cleanupCommandString);
      removeSessionRoot(sessionRoot);
      void launchMetadata.stop().finally(() => resolve(code));
    };

    const child = spawn(spec.bin, finalArgs, {
      stdio: 'inherit',
      env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env
    });

    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code, signal) => {
      finish(code ?? signalExitCode(signal));
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          `Failed to spawn "${spec.bin}": binary not found on PATH. Install the ${runtime.harness} CLI and retry.\n`
        );
      } else {
        process.stderr.write(`Failed to spawn "${spec.bin}": ${err.message}\n`);
      }
      finish(127);
    });
  });
}

function formatAvailabilityTable(results: readonly HarnessAvailability[]): string {
  const rows = results.map((r) => ({
    harness: r.harness,
    status: r.available ? 'ok' : 'missing',
    version: r.available ? (r.version ?? '') : '',
    detail: r.available ? (r.path ?? '') : (r.error ?? '')
  }));
  const headers = { harness: 'HARNESS', status: 'STATUS', version: 'VERSION', detail: 'DETAIL' };
  const cols = ['harness', 'status', 'version', 'detail'] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => r[c].length))])
  ) as Record<(typeof cols)[number], number>;
  const line = (row: Record<(typeof cols)[number], string>) =>
    cols.map((c) => row[c].padEnd(widths[c])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n') + '\n';
}

interface SourceDirRow {
  cascade: string;
  config: string;
  source: string;
  exists: string;
  dir: string;
}

function collectSourceDirRows(): {
  configPath: string;
  personaDirs: string[];
  defaultCreateTarget?: string;
  rows: SourceDirRow[];
} {
  const { directories, config } = buildPersonaSourceDirectories();
  const rows: SourceDirRow[] = directories.map((sourceDir, idx) => ({
    cascade: String(idx + 1),
    config: sourceDir.configurable ? String(config.personaDirs.indexOf(sourceDir.dir) + 1) : '-',
    source: sourceDir.source,
    exists: existsSync(sourceDir.dir) ? 'yes' : 'no',
    dir: sourceDir.dir
  }));
  rows.push({
    cascade: String(rows.length + 1),
    config: '-',
    source: 'library',
    exists: 'yes',
    dir: '(built-in)'
  });
  return {
    configPath: config.configPath,
    personaDirs: config.personaDirs,
    ...(config.defaultCreateTarget ? { defaultCreateTarget: config.defaultCreateTarget } : {}),
    rows
  };
}

function formatSourcesTable(
  rows: readonly SourceDirRow[],
  configPath: string,
  defaultCreateTarget: string | undefined
): string {
  const headers: SourceDirRow = {
    cascade: 'CASCADE',
    config: 'CONFIG',
    source: 'SOURCE',
    exists: 'EXISTS',
    dir: 'DIR'
  };
  const cols = ['cascade', 'config', 'source', 'exists', 'dir'] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => r[c].length))])
  ) as Record<(typeof cols)[number], number>;
  const line = (row: SourceDirRow) =>
    cols.map((c) => row[c].padEnd(widths[c])).join('  ').trimEnd();
  return [
    `Config: ${configPath}`,
    `Default create target: ${defaultCreateTarget ?? '(auto)'}`,
    [line(headers), ...rows.map(line)].join('\n'),
    ''
  ].join('\n');
}

function parseSourcesListArgs(args: readonly string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: agentworkforce sources list [--json]\n');
      process.exit(0);
    } else {
      die(`sources list: unexpected argument "${arg}".`);
    }
  }
  return { json };
}

function runSourcesList(args: readonly string[]): never {
  const { json } = parseSourcesListArgs(args);
  const { configPath, personaDirs, defaultCreateTarget, rows } = collectSourceDirRows();
  if (json) {
    process.stdout.write(
      JSON.stringify({ configPath, personaDirs, defaultCreateTarget, sources: rows }, null, 2) + '\n'
    );
  } else {
    process.stdout.write(formatSourcesTable(rows, configPath, defaultCreateTarget));
  }
  process.exit(0);
}

function assertDirectoryForAdd(dir: string): void {
  try {
    if (!existsSync(dir)) {
      die(`sources add: directory does not exist: ${dir}`);
    }
    if (!statSync(dir).isDirectory()) {
      die(`sources add: path is not a directory: ${dir}`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith('sources add:')) throw err;
    die(`sources add: could not inspect ${dir}: ${(err as Error).message}`);
  }
}

function parseSourcesAddArgs(args: readonly string[]): { dir: string; position?: number } {
  let dir: string | undefined;
  let position: number | undefined;
  const valueOf = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      die(`sources add: ${flag} requires a value.`);
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: agentworkforce sources add <dir> [--position <n>]\n');
      process.exit(0);
    } else if (arg === '--position') {
      const raw = valueOf(i++, arg);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        die(`sources add: --position must be a positive integer.`);
      }
      position = parsed;
    } else if (arg.startsWith('--')) {
      die(`sources add: unexpected flag "${arg}".`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      die(`sources add: unexpected argument "${arg}".`);
    }
  }
  if (!dir) die('sources add: missing directory.');
  return { dir, position };
}

function runSourcesAdd(args: readonly string[]): never {
  const { dir: rawDir, position } = parseSourcesAddArgs(args);
  const dir = normalizePersonaDir(rawDir);
  assertDirectoryForAdd(dir);

  const config = loadPersonaSourceConfig();
  if (config.personaDirs.includes(dir)) {
    die(`sources add: directory is already configured: ${dir}`);
  }
  const insertAt = position === undefined ? config.personaDirs.length : position - 1;
  if (insertAt < 0 || insertAt > config.personaDirs.length) {
    die(
      `sources add: --position must be between 1 and ${config.personaDirs.length + 1}.`
    );
  }
  const nextDirs = [...config.personaDirs];
  nextDirs.splice(insertAt, 0, dir);
  const saved = savePersonaSourceConfig(nextDirs);
  process.stdout.write(
    `Added persona source directory at configurable position ${insertAt + 1}: ${dir}\nConfig: ${saved.configPath}\n`
  );
  process.exit(0);
}

function parseSourcesRemoveArgs(args: readonly string[]): { target: string } {
  let target: string | undefined;
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: agentworkforce sources remove <dir|config-position>\n');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      die(`sources remove: unexpected flag "${arg}".`);
    } else if (target === undefined) {
      target = arg;
    } else {
      die(`sources remove: unexpected argument "${arg}".`);
    }
  }
  if (!target) die('sources remove: missing directory or config-position.');
  return { target };
}

function runSourcesRemove(args: readonly string[]): never {
  const { target } = parseSourcesRemoveArgs(args);
  const config = loadPersonaSourceConfig();
  let idx: number;
  if (/^[1-9]\d*$/.test(target)) {
    idx = Number(target) - 1;
  } else {
    const dir = normalizePersonaDir(target);
    idx = config.personaDirs.indexOf(dir);
  }
  if (idx < 0 || idx >= config.personaDirs.length) {
    die(`sources remove: no configurable persona source matched "${target}".`);
  }
  const nextDirs = [...config.personaDirs];
  const [removed] = nextDirs.splice(idx, 1);
  const saved = savePersonaSourceConfig(nextDirs);
  process.stdout.write(
    `Removed persona source directory from configurable position ${idx + 1}: ${removed}\nConfig: ${saved.configPath}\n`
  );
  process.exit(0);
}

function runSources(args: readonly string[]): never {
  const [action, ...rest] = args;
  if (!action || action === '-h' || action === '--help') {
    process.stdout.write(
      'Usage: agentworkforce sources <list|add|remove> [args...]\n' +
        '  agentworkforce sources list [--json]\n' +
        '  agentworkforce sources add <dir> [--position <n>]\n' +
        '  agentworkforce sources remove <dir|config-position>\n'
    );
    process.exit(action ? 0 : 1);
  }
  if (action === 'list') runSourcesList(rest);
  if (action === 'add') runSourcesAdd(rest);
  if (action === 'remove') runSourcesRemove(rest);
  die(`sources: unknown action "${action}". Expected: list, add, remove.`);
}

export interface PersonaInstallArgs {
  source: string;
  personaIds: string[];
  overwrite: boolean;
}

export function parseInstallArgs(args: readonly string[]): PersonaInstallArgs {
  let source: string | undefined;
  const personaIds: string[] = [];
  let overwrite = false;
  const valueOf = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`install: ${flag} requires a value.`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--overwrite') {
      overwrite = true;
    } else if (arg === '--persona') {
      const value = valueOf(i++, arg);
      if (!value.trim()) throw new Error('install: --persona requires a non-empty value.');
      personaIds.push(value);
    } else if (arg.startsWith('--')) {
      throw new Error(`install: unexpected flag "${arg}".`);
    } else if (source === undefined) {
      source = arg;
    } else {
      throw new Error(`install: unexpected argument "${arg}".`);
    }
  }

  if (!source) throw new Error('install: missing package or local path.');
  return { source, personaIds, overwrite };
}

function formatPersonaInstallSummary(result: PersonaInstallResult): string {
  const lines: string[] = [];
  for (const persona of result.installed) {
    lines.push(`installed ${persona.id} -> ${persona.targetPath}`);
  }
  if (result.installed.length > 0) {
    lines.push(
      `Installed ${result.installed.length} persona(s) into ${result.targetDir}.`
    );
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatPersonaInstallConflicts(result: PersonaInstallResult): string {
  if (result.conflicts.length === 0) return '';
  const lines = result.conflicts.map(
    (conflict) =>
      `conflict ${conflict.id}: ${conflict.targetPath} already exists (use --overwrite to replace it)`
  );
  lines.push(
    `Skipped ${result.conflicts.length} existing persona file(s); re-run with --overwrite to replace.`
  );
  return lines.join('\n') + '\n';
}

function runPersonaInstall(args: readonly string[]): never {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(
      'Usage: agentworkforce install <pkg|path> [--persona <id> ...] [--overwrite]\n'
    );
    process.exit(0);
  }
  let parsed: PersonaInstallArgs;
  try {
    parsed = parseInstallArgs(args);
  } catch (err) {
    die((err as Error).message);
  }

  let result: PersonaInstallResult;
  try {
    result = installPersonas({
      source: parsed.source,
      personaIds: parsed.personaIds,
      overwrite: parsed.overwrite
    });
  } catch (err) {
    die((err as Error).message, false);
  }

  process.stdout.write(formatPersonaInstallSummary(result));
  process.stderr.write(formatPersonaInstallConflicts(result));
  process.exit(result.conflicts.length > 0 ? 1 : 0);
}

interface PersonaListRow {
  persona: string;
  source: PersonaSource;
  harness: string;
  model: string;
  intent: string;
  tags: PersonaTag[];
  description: string;
  rating: PersonaTier;
}

function collectPersonaRows(): PersonaListRow[] {
  const rows: PersonaListRow[] = [];
  const pushSpec = (spec: PersonaSpec, source: PersonaSource): void => {
    for (const tier of PERSONA_TIERS) {
      rows.push({
        persona: spec.id,
        source,
        harness: spec.tiers[tier].harness,
        model: spec.tiers[tier].model,
        intent: spec.intent,
        tags: spec.tags,
        description: spec.description,
        rating: tier
      });
    }
  };
  const seen = new Set<string>();
  for (const [id, spec] of local.byId) {
    pushSpec(spec, local.sources.get(id) ?? 'library');
    seen.add(id);
  }
  for (const spec of Object.values(personaCatalog)) {
    if (seen.has(spec.id)) continue;
    pushSpec(spec, 'library');
  }
  const tierOrder = new Map(PERSONA_TIERS.map((t, i) => [t, i] as const));
  return rows.sort(
    (a, b) =>
      a.persona.localeCompare(b.persona) ||
      (tierOrder.get(a.rating)! - tierOrder.get(b.rating)!)
  );
}

interface ListDisplayOptions {
  description: boolean;
}

function formatPersonaTable(
  rows: readonly PersonaListRow[],
  display: ListDisplayOptions
): string {
  interface RenderRow {
    persona: string;
    source: string;
    harness: string;
    model: string;
    rating: string;
    tags: string;
    description: string;
  }
  const headers: RenderRow = {
    persona: 'PERSONA',
    source: 'SOURCE',
    harness: 'HARNESS',
    model: 'MODEL',
    rating: 'RATING',
    tags: 'TAGS',
    description: 'DESCRIPTION'
  };
  const rendered: RenderRow[] = rows.map((r) => ({
    persona: r.persona,
    source: r.source,
    harness: r.harness,
    model: r.model,
    rating: r.rating,
    tags: r.tags.join(','),
    description: r.description
  }));
  const widths = {
    persona: Math.max(headers.persona.length, ...rendered.map((r) => r.persona.length)),
    source: Math.max(headers.source.length, ...rendered.map((r) => r.source.length)),
    harness: Math.max(headers.harness.length, ...rendered.map((r) => r.harness.length)),
    model: Math.max(headers.model.length, ...rendered.map((r) => r.model.length)),
    rating: Math.max(headers.rating.length, ...rendered.map((r) => r.rating.length)),
    tags: Math.max(headers.tags.length, ...rendered.map((r) => r.tags.length)),
    description: headers.description.length
  };
  const termWidth =
    process.stdout.isTTY && typeof process.stdout.columns === 'number' ? process.stdout.columns : 140;
  const fixed =
    widths.persona +
    widths.source +
    widths.harness +
    widths.model +
    widths.rating +
    widths.tags +
    (6 + (display.description ? 1 : 0) - 1) * 2;
  const descBudget = Math.max(20, termWidth - fixed - 1);
  const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…');
  const line = (row: RenderRow) => {
    const parts = [
      row.persona.padEnd(widths.persona),
      row.source.padEnd(widths.source),
      row.harness.padEnd(widths.harness),
      row.model.padEnd(widths.model),
      row.rating.padEnd(widths.rating),
      row.tags.padEnd(widths.tags)
    ];
    if (display.description) {
      parts.push(truncate(row.description.replace(/\s+/g, ' ').trim(), descBudget));
    }
    return parts.join('  ').trimEnd();
  };
  return [line(headers), ...rendered.map(line)].join('\n') + '\n';
}

function parseListArgs(args: readonly string[]): {
  json: boolean;
  filterRating?: PersonaTier;
  filterHarness?: Harness;
  filterTag?: PersonaTag;
  display: ListDisplayOptions;
  showAll: boolean;
  filterRatingExplicit: boolean;
} {
  let json = false;
  let filterRating: PersonaTier | undefined;
  let filterRatingExplicit = false;
  let filterHarness: Harness | undefined;
  let filterTag: PersonaTag | undefined;
  let showAll = false;
  const display: ListDisplayOptions = { description: true };

  const valueOf = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      die(`list: ${flag} requires a value.`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: agentworkforce list [--all] [--json] [--filter-rating <tier>] [--filter-harness <harness>] [--filter-tag <tag>] [--no-display-description]\n'
      );
      process.exit(0);
    } else if (arg === '--all' || arg === '--no-recommended') {
      showAll = true;
    } else if (arg === '--recommended') {
      showAll = false;
    } else if (arg === '--filter-rating') {
      const v = valueOf(i++, arg);
      if (!(PERSONA_TIERS as readonly string[]).includes(v)) {
        die(`list: invalid --filter-rating "${v}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
      }
      filterRating = v as PersonaTier;
      filterRatingExplicit = true;
    } else if (arg === '--filter-harness') {
      const v = valueOf(i++, arg);
      if (!(HARNESS_VALUES as readonly string[]).includes(v)) {
        die(`list: invalid --filter-harness "${v}". Must be one of: ${HARNESS_VALUES.join(', ')}`);
      }
      filterHarness = v as Harness;
    } else if (arg === '--filter-tag') {
      const v = valueOf(i++, arg);
      if (!(PERSONA_TAGS as readonly string[]).includes(v)) {
        die(`list: invalid --filter-tag "${v}". Must be one of: ${PERSONA_TAGS.join(', ')}`);
      }
      filterTag = v as PersonaTag;
    } else if (arg === '--display-description') {
      display.description = true;
    } else if (arg === '--no-display-description') {
      display.description = false;
    } else {
      die(`list: unexpected argument "${arg}".`);
    }
  }
  return { json, filterRating, filterHarness, filterTag, display, showAll, filterRatingExplicit };
}

function runList(args: readonly string[]): never {
  const { json, filterRating, filterHarness, filterTag, display, showAll, filterRatingExplicit } =
    parseListArgs(args);

  const recommendedByIntent = routingProfiles.default.intents;
  const applyRecommended = !showAll && !filterRatingExplicit;

  const rows = collectPersonaRows().filter((r) => {
    if (filterRating && r.rating !== filterRating) return false;
    if (filterHarness && r.harness !== filterHarness) return false;
    if (filterTag && !r.tags.includes(filterTag)) return false;
    if (applyRecommended) {
      const rule = recommendedByIntent[r.intent as PersonaIntent];
      if (!rule || r.rating !== rule.tier) return false;
    }
    return true;
  });

  if (json) {
    process.stdout.write(JSON.stringify({ personas: rows }, null, 2) + '\n');
  } else {
    process.stdout.write(formatPersonaTable(rows, display));
    const uniq = new Set(rows.map((r) => r.persona)).size;
    const suffix = applyRecommended ? ' (recommended tier per intent; pass --all to see every tier)' : '';
    process.stdout.write(`\n${uniq} persona(s), ${rows.length} row(s)${suffix}.\n`);
  }
  process.exit(0);
}

function parseShowArgs(args: readonly string[]): {
  selector: string;
  json: boolean;
  all: boolean;
} {
  let json = false;
  let all = false;
  let selector: string | undefined;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: agentworkforce show <persona>[@<tier>] [--all] [--json]\n');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      die(`show: unexpected flag "${arg}".`);
    } else if (selector === undefined) {
      selector = arg;
    } else {
      die(`show: unexpected argument "${arg}".`);
    }
  }
  if (!selector) die('show: missing persona name.');
  return { selector, json, all };
}

function resolveShowTarget(
  selector: string,
  all: boolean
): {
  spec: PersonaSpec;
  source: PersonaSource;
  tiers: PersonaTier[];
  explicitTier: PersonaTier | undefined;
} {
  const at = selector.indexOf('@');
  const key = at === -1 ? selector : selector.slice(0, at);
  const tierRaw = at === -1 ? undefined : selector.slice(at + 1);
  if (!key) die('show: missing persona name before "@".');
  let explicitTier: PersonaTier | undefined;
  if (tierRaw !== undefined) {
    if (!PERSONA_TIERS.includes(tierRaw as PersonaTier)) {
      die(`show: invalid tier "${tierRaw}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
    }
    explicitTier = tierRaw as PersonaTier;
    if (all) {
      die('show: --all cannot be combined with an explicit @<tier> suffix.');
    }
  }

  const localSpec = local.byId.get(key);
  let spec: PersonaSpec | undefined;
  let source: PersonaSource = 'library';
  if (localSpec) {
    spec = localSpec;
    source = local.sources.get(key) ?? 'cwd';
  } else {
    const byIntent = (personaCatalog as Record<string, PersonaSpec>)[key];
    if (byIntent) {
      spec = byIntent;
    } else {
      const byId = Object.values(personaCatalog).find((p) => p.id === key);
      if (byId) spec = byId;
    }
  }
  if (!spec) {
    const result = resolveSpec(key);
    if ('error' in result) die(result.error, false);
    spec = result;
  }

  let tiers: PersonaTier[];
  if (all) {
    tiers = [...PERSONA_TIERS];
  } else if (explicitTier) {
    tiers = [explicitTier];
  } else {
    const rule = routingProfiles.default.intents[spec.intent];
    tiers = [rule?.tier ?? 'best-value'];
  }
  return { spec, source, tiers, explicitTier };
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

function formatPersonaShow(
  spec: PersonaSpec,
  source: PersonaSource,
  tiers: readonly PersonaTier[],
  tierNote: string
): string {
  const lines: string[] = [];
  lines.push(`PERSONA      ${spec.id}`);
  lines.push(`SOURCE       ${source}`);
  lines.push(`INTENT       ${spec.intent}`);
  lines.push(`TAGS         ${spec.tags.length ? spec.tags.join(', ') : '(none)'}`);
  lines.push(`DESCRIPTION  ${spec.description}`);
  lines.push(`TIERS SHOWN  ${tiers.join(', ')}${tierNote ? `  (${tierNote})` : ''}`);

  lines.push('');
  lines.push('SKILLS');
  if (spec.skills.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of spec.skills) {
      lines.push(`  - ${s.id}`);
      lines.push(`      source:      ${s.source}`);
      lines.push(`      description: ${s.description}`);
    }
  }

  lines.push('');
  lines.push('INPUTS');
  const inputs = Object.entries(spec.inputs ?? {});
  if (inputs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, input] of inputs) {
      lines.push(`  - ${name}`);
      if (input.description) lines.push(`      description: ${input.description}`);
      lines.push(`      env:         ${input.env ?? name}`);
      lines.push(`      default:     ${input.default ?? '(required)'}`);
    }
  }

  lines.push('');
  lines.push('MCP SERVERS');
  const servers = Object.entries(spec.mcpServers ?? {});
  if (servers.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, server] of servers) {
      lines.push(`  - ${name} (${server.type})`);
      if (server.type === 'stdio') {
        lines.push(`      command: ${server.command}${server.args?.length ? ' ' + server.args.join(' ') : ''}`);
        if (server.env && Object.keys(server.env).length > 0) {
          lines.push(`      env:     ${Object.keys(server.env).join(', ')}`);
        }
      } else {
        lines.push(`      url:     ${server.url}`);
        if (server.headers && Object.keys(server.headers).length > 0) {
          lines.push(`      headers: ${Object.keys(server.headers).join(', ')}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('PERMISSIONS');
  const perms = spec.permissions;
  if (!perms || (!perms.allow?.length && !perms.deny?.length && !perms.mode)) {
    lines.push('  (none)');
  } else {
    if (perms.mode) lines.push(`  mode:  ${perms.mode}`);
    if (perms.allow?.length) lines.push(`  allow: ${perms.allow.join(', ')}`);
    if (perms.deny?.length) lines.push(`  deny:  ${perms.deny.join(', ')}`);
  }

  lines.push('');
  lines.push('MOUNT');
  const mount = spec.mount;
  if (!mount || (!mount.ignoredPatterns?.length && !mount.readonlyPatterns?.length)) {
    lines.push('  (none)');
  } else {
    if (mount.ignoredPatterns?.length) {
      lines.push(`  ignored:  ${mount.ignoredPatterns.join(', ')}`);
    }
    if (mount.readonlyPatterns?.length) {
      lines.push(`  readonly: ${mount.readonlyPatterns.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('ENV');
  const envKeys = Object.keys(spec.env ?? {});
  if (envKeys.length === 0) {
    lines.push('  (none)');
  } else {
    for (const k of envKeys) lines.push(`  ${k}=${spec.env![k]}`);
  }

  for (const tier of tiers) {
    const rt = spec.tiers[tier];
    lines.push('');
    lines.push(`TIER: ${tier}`);
    lines.push(`  harness:  ${rt.harness}`);
    lines.push(`  model:    ${rt.model}`);
    lines.push(`  reasoning: ${rt.harnessSettings.reasoning}`);
    lines.push(`  timeout:  ${rt.harnessSettings.timeoutSeconds}s`);
    lines.push('  systemPrompt:');
    lines.push(indent(rt.systemPrompt, '    '));
  }

  return lines.join('\n') + '\n';
}

function runShow(args: readonly string[]): never {
  const { selector, json, all } = parseShowArgs(args);
  const { spec, source, tiers, explicitTier } = resolveShowTarget(selector, all);
  const tierNote = all
    ? 'all tiers'
    : explicitTier
      ? 'explicit @<tier>'
      : 'recommended for intent; pass --all or @<tier> to override';
  if (json) {
    const projectedTiers = Object.fromEntries(
      tiers.map((t) => [t, spec.tiers[t]])
    ) as PersonaSpec['tiers'];
    const projected: PersonaSpec = { ...spec, tiers: projectedTiers };
    process.stdout.write(JSON.stringify({ source, spec: projected }, null, 2) + '\n');
  } else {
    process.stdout.write(formatPersonaShow(spec, source, tiers, tierNote));
  }
  process.exit(0);
}

function runHarnessCheck(): never {
  const results = detectHarnesses();
  process.stdout.write(formatAvailabilityTable(results));
  const available = results.filter((r) => r.available).length;
  process.stdout.write(`\n${available}/${results.length} harness(es) available.\n`);
  process.exit(0);
}

interface CreateTarget {
  raw: string;
  kind: string;
  dir: string;
  createMode: 'local' | 'built-in';
}

function defaultCreateTargetSelector(): string {
  if (existsSync(join(process.cwd(), '.agentworkforce', 'workforce'))) {
    return 'cwd';
  }
  return loadPersonaSourceConfig().defaultCreateTarget ?? 'user';
}

function resolveCreateTarget(rawTarget: string | undefined): CreateTarget {
  const raw = rawTarget?.trim() || defaultCreateTargetSelector();
  const config = loadPersonaSourceConfig();

  if (raw === 'cwd') {
    return {
      raw,
      kind: 'cwd',
      dir: defaultCwdPersonaDir(process.cwd()),
      createMode: 'local'
    };
  }
  if (raw === 'user') {
    return {
      raw,
      kind: 'user',
      dir: config.userPersonaDir,
      createMode: 'local'
    };
  }
  if (raw === 'library') {
    const dir = resolvePath(process.cwd(), 'personas');
    if (!existsSync(dir)) {
      die(
        'create: --to library requires running from the AgentWorkforce repo root, where ./personas exists.'
      );
    }
    return {
      raw,
      kind: 'library',
      dir,
      createMode: 'built-in'
    };
  }
  const dirMatch = /^dir:([1-9]\d*)$/.exec(raw);
  if (dirMatch) {
    const idx = Number(dirMatch[1]) - 1;
    const dir = config.personaDirs[idx];
    if (!dir) {
      die(`create: ${raw} does not exist. Run "agentworkforce sources list" to see configured dirs.`);
    }
    return {
      raw,
      kind: raw,
      dir,
      createMode: 'local'
    };
  }

  return {
    raw: normalizePersonaDir(raw),
    kind: 'path',
    dir: normalizePersonaDir(raw),
    createMode: 'local'
  };
}

function buildCreateInputValues(target: CreateTarget): Record<string, string> {
  return {
    [CREATE_INPUT_TARGET_DIR]: target.dir,
    [CREATE_INPUT_CREATE_MODE]: target.createMode
  };
}

function ensureCreateTargetDir(target: CreateTarget): void {
  if (target.createMode === 'built-in') return;
  mkdirSync(target.dir, { recursive: true });
}

function saveDefaultCreateTarget(target: CreateTarget): void {
  const config = loadPersonaSourceConfig();
  const raw = target.kind === 'path' ? target.dir : target.raw;
  const saved = savePersonaSourceConfig(config.personaDirs, { defaultCreateTarget: raw });
  process.stderr.write(`• default create target saved: ${raw}\n`);
  process.stderr.write(`• config: ${saved.configPath}\n`);
}

async function runAgentSelector(
  selector: string,
  flags: AgentFlags,
  inputValues?: Record<string, string>
): Promise<never> {
  const target = parseSelector(selector);
  const selection = {
    ...buildSelection(target.spec, target.tier, target.kind),
    ...(inputValues ? { inputValues } : {})
  };

  const code = await runInteractive(selection, {
    installInRepo: flags.installInRepo,
    noLaunchMetadata: flags.noLaunchMetadata,
    personaSpec: target.spec,
    personaSource: target.source
  });
  process.exit(code);
}

/**
 * Enumerate persona candidates for the picker. Local overrides win over the
 * built-in catalog when ids collide; the picker only needs the projection
 * fields ({@link PickCandidate}), not full specs.
 */
export function buildPickCandidates(): PickCandidate[] {
  const byId = new Map<string, PickCandidate>();
  for (const spec of Object.values(personaCatalog)) {
    byId.set(spec.id, {
      id: spec.id,
      intent: spec.intent,
      tags: [...spec.tags],
      description: spec.description
    });
  }
  for (const [id, spec] of local.byId.entries()) {
    byId.set(id, {
      id,
      intent: spec.intent,
      tags: [...spec.tags],
      description: spec.description
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Synchronous y/n prompt over /dev/tty-equivalent stdin. Default is "no" on
 * empty input or non-y answer. Used by `pick` when the picker reports
 * no-match in an interactive session.
 *
 * Test seam: callers can inject `read` so the prompt path is exercisable
 * without a real TTY.
 */
export function promptYesNoSync(
  question: string,
  opts: {
    isTTY?: boolean;
    write?: (chunk: string) => void;
    read?: () => string | undefined;
  } = {}
): boolean {
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!isTTY) return false;
  const write = opts.write ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  write(question);
  const answer = opts.read ? opts.read() : readLineFromStdinSync();
  if (!answer) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

function readLineFromStdinSync(): string | undefined {
  const buf = Buffer.alloc(256);
  let line = '';
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      return line || undefined;
    }
    if (n <= 0) return line || undefined;
    const chunk = buf.subarray(0, n).toString('utf8');
    const newlineIdx = chunk.indexOf('\n');
    if (newlineIdx === -1) {
      line += chunk;
      continue;
    }
    line += chunk.slice(0, newlineIdx);
    return line;
  }
}

async function runPick(args: readonly string[]): Promise<never> {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: agentworkforce pick "<task description>"\n' +
          '  Prints the best-fit persona id to stdout. On low confidence, prompts to\n' +
          '  open persona-maker (TTY) or exits 2 (non-TTY). Exits 3 if `claude` is\n' +
          '  not installed.\n'
      );
      process.exit(0);
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    die('pick: missing task description. Usage: agentworkforce pick "<task>"');
  }
  if (positional.length > 1) {
    die(
      `pick: expected a single quoted task description, got ${positional.length} arguments. ` +
        `Did you forget to quote the task? Try: agentworkforce pick "${positional.join(' ')}"`
    );
  }
  const task = positional[0].trim();
  if (!task) {
    die('pick: task description is empty.');
  }

  const candidates = buildPickCandidates();
  const result: PickResult = pickPersona(task, candidates);

  if (result.kind === 'match') {
    process.stderr.write(
      `• picked ${result.personaId} (${result.confidence}): ${result.reason}\n`
    );
    process.stdout.write(`${result.personaId}\n`);
    process.exit(0);
  }

  if (result.kind === 'picker-unavailable') {
    process.stderr.write(`pick: ${result.message}\n`);
    process.exit(3);
  }

  // no-match
  process.stderr.write(`pick: no close persona match — ${result.reason}\n`);
  const wantsCreate = promptYesNoSync(
    'Open persona-maker to scaffold a new persona for this task? [y/N] '
  );
  if (!wantsCreate) {
    process.stderr.write(
      'Try: agentworkforce list   # to browse existing personas\n' +
        '     agentworkforce create  # to author a new persona\n'
    );
    process.exit(2);
  }

  const target = resolveCreateTarget(undefined);
  ensureCreateTargetDir(target);
  const inputValues = {
    ...buildCreateInputValues(target),
    TASK_DESCRIPTION: task
  };
  await runAgentSelector(
    CREATE_SELECTOR,
    { installInRepo: false, noLaunchMetadata: false },
    inputValues
  );
  // runAgentSelector terminates via process.exit; this satisfies TS's
  // reachable-end-point check for the `Promise<never>` return type.
  process.exit(0);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === '-v' || subcommand === '--version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    process.exit(0);
  }

  if (subcommand === 'list') {
    runList(rest);
  }

  if (subcommand === 'show') {
    runShow(rest);
  }

  if (subcommand === 'install') {
    runPersonaInstall(rest);
  }

  if (subcommand === 'sources') {
    runSources(rest);
  }

  if (subcommand === 'harness') {
    const [action, ...extra] = rest;
    if (!action || action === '-h' || action === '--help') {
      die('harness: missing action. Expected: check');
    }
    if (action !== 'check') {
      die(`harness: unknown action "${action}". Expected: check`);
    }
    if (extra.length > 0) {
      die(`harness check: unexpected argument "${extra[0]}".`);
    }
    runHarnessCheck();
  }

  if (subcommand === 'create') {
    const { flags, selector, inputValues } = parseCreateArgs(rest);
    await runAgentSelector(selector, flags, inputValues);
  }

  if (subcommand === 'pick') {
    await runPick(rest);
  }

  if (subcommand !== 'agent') {
    die(`Unknown subcommand "${subcommand}".`);
  }

  const { flags, positional } = parseAgentArgs(rest);
  const [selector, ...extra] = positional;
  if (!selector) die('agent: missing persona selector.');
  if (extra.length > 0) {
    die(`agent: unexpected argument "${extra[0]}". The agent subcommand only takes a persona selector.`);
  }

  await runAgentSelector(selector, flags);
}

export interface AgentFlags {
  installInRepo: boolean;
  noLaunchMetadata: boolean;
}

export interface CreateFlags extends AgentFlags {
  to?: string;
  saveDefault: boolean;
}

export function parseAgentArgs(args: readonly string[]): {
  flags: AgentFlags;
  positional: string[];
} {
  const flags: AgentFlags = { installInRepo: false, noLaunchMetadata: false };
  const positional: string[] = [];
  let seenDoubleDash = false;
  for (const arg of args) {
    if (seenDoubleDash) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (arg === '--install-in-repo') {
      flags.installInRepo = true;
      continue;
    }
    if (arg === '--no-launch-metadata') {
      flags.noLaunchMetadata = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    positional.push(arg);
  }
  return { flags, positional };
}

export function parseCreateArgs(args: readonly string[]): {
  flags: CreateFlags;
  selector: string;
  inputValues: Record<string, string>;
} {
  const flags: CreateFlags = { installInRepo: false, noLaunchMetadata: false, saveDefault: false };
  let seenDoubleDash = false;
  const positional: string[] = [];
  const valueOf = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      die(`create: ${flag} requires a value.`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seenDoubleDash) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (arg === '--install-in-repo') {
      flags.installInRepo = true;
      continue;
    }
    if (arg === '--no-launch-metadata') {
      flags.noLaunchMetadata = true;
      continue;
    }
    if (arg === '--to') {
      flags.to = valueOf(i, arg);
      i += 1;
      continue;
    }
    if (arg === '--save-default') {
      flags.saveDefault = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: agentworkforce create [--to <cwd|user|dir:n|library|path>] [--save-default] [--install-in-repo] [--no-launch-metadata]\n'
      );
      process.exit(0);
    }
    positional.push(arg);
  }

  const [unexpected] = positional;
  if (unexpected) {
    die(
      `create: unexpected argument "${unexpected}". The create command always runs ${CREATE_SELECTOR}; use "agentworkforce agent <persona>[@<tier>]" to run another persona.`
    );
  }

  const target = resolveCreateTarget(flags.to);
  ensureCreateTargetDir(target);
  if (flags.saveDefault) saveDefaultCreateTarget(target);

  return {
    flags,
    selector: CREATE_SELECTOR,
    inputValues: buildCreateInputValues(target)
  };
}

// Only run main when invoked as the CLI entry, not when imported by tests.
// Node ESM: import.meta.url is the module URL; argv[1] is the entry script
// path, which may be relative (e.g. `node ./dist/cli.js`) and pathToFileURL
// throws on relative paths. Resolve to absolute first.
const isCliEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(entry)).href;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err) => {
    if (err instanceof MissingPersonaInputError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  });
}
