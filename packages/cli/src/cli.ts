#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs';
import { constants, homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCleanupArtifacts,
  buildInstallArtifacts,
  buildInteractiveSpec,
  buildNonInteractiveSpec,
  detectHarnesses,
  formatDropWarnings,
  HARNESS_VALUES,
  materializeSkills,
  MissingPersonaInputError,
  PERSONA_TAGS,
  PERSONA_TIERS,
  renderPersonaInputs,
  resolveMcpServersLenient,
  resolvePersonaInputs,
  resolveSidecar,
  resolveStringMapLenient,
  type Harness,
  type HarnessAvailability,
  type InteractiveSpec,
  type NonInteractiveSpec,
  type PersonaMount,
  type PersonaSelection,
  type PersonaSpec,
  type PersonaTag,
  type PersonaTier,
  type SidecarMdMode,
  type SkillMaterializationPlan
} from '@agentworkforce/persona-kit';
import {
  listBuiltInPersonas,
  personaCatalog,
  routingProfiles
} from '@agentworkforce/workload-router';
import {
  createMount,
  readAgentDotfiles,
  type AutoSyncHandle
} from '@relayfile/local-mount';
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
import { recordRecent, loadRecents, runPersonaPickerTui, type TuiCandidate } from './persona-tui.js';

const USAGE = `Usage: agentworkforce <command> [args...]

Run with no arguments inside a TTY to open an interactive persona picker —
the top 3 most recently used personas are shown first, and typing fuzzy-
searches across persona names and descriptions.

Commands:
  create [flags]     Opens persona-maker@best for creating a new
                      persona, with target path passed as persona inputs.
                      Flags:
                        --save-in-directory=<target>
                                            Storage target: cwd, user, dir:n,
                                            library, or an explicit path.
                                            Default: cwd
                                            (<cwd>/.agentworkforce/workforce/personas);
                                            the directory is created if missing.
                                            Override via this flag, or pin a
                                            different default with --save-default.
                        --save-default      Persist --save-in-directory as
                                            defaultCreateTarget in
                                            ~/.agentworkforce/workforce/config.json.
                        --install-in-repo   Same behavior as agent.
                        --no-launch-metadata
                                            Same behavior as agent.
  agent [flags] <persona>[@<tier>]
                      Run a persona. Tier one of: ${PERSONA_TIERS.join(' | ')}.
                      With no @<tier>, the resolution order is:
                      routingProfiles.default.intents (built-in personas only)
                      → persona.defaultTier (when set) → best-value. Drops into
                      an interactive harness session.

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
                        --dry-run           Validate the persona without
                                            spawning the harness or burning
                                            tier-model tokens. Three checks:
                                            (1) sidecar — claudeMd / agentsMd
                                            filename refs are readable;
                                            (2) harness spec — permissions /
                                            mcpServers / harness-settings
                                            shape is accepted by the harness
                                            translator; (3) skills — each
                                            \`skills[].source\` is run through
                                            its real installer (npx skills
                                            add / npx prpm install) inside a
                                            fresh temp dir, with per-skill
                                            pass/fail reporting. Use this in
                                            the persona-author loop to catch
                                            hallucinated skill names and
                                            malformed config before a persona
                                            ships. Temp dir is removed on
                                            success, kept on failure for
                                            inspection.
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
  agentworkforce create --save-in-directory=user
  agentworkforce install @agentworkforce/personas-core --persona code-reviewer
  agentworkforce agent code-reviewer@best-value
  agentworkforce agent my-reviewer@best
  agentworkforce list
  agentworkforce show code-reviewer
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

interface KnownPersonaRow {
  name: string;
  description: string;
}

function collectKnownPersonas(): KnownPersonaRow[] {
  const byName = new Map<string, KnownPersonaRow>();
  for (const spec of local.byId.values()) {
    byName.set(spec.id, {
      name: spec.id,
      description: spec.description
    });
  }
  for (const spec of listBuiltInPersonas()) {
    if (byName.has(spec.id)) continue;
    byName.set(spec.id, {
      name: spec.id,
      description: spec.description
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatNameDescriptionTable(rows: readonly KnownPersonaRow[]): string {
  const headers: KnownPersonaRow = {
    name: 'NAME',
    description: 'DESCRIPTION'
  };
  const rendered = rows.map((r) => ({
    name: r.name,
    description: r.description.replace(/\s+/g, ' ').trim()
  }));
  const nameWidth = Math.max(
    headers.name.length,
    ...rendered.map((r) => r.name.length)
  );
  const termWidth =
    process.stderr.isTTY && typeof process.stderr.columns === 'number'
      ? process.stderr.columns
      : 120;
  const descBudget = Math.max(
    headers.description.length,
    Math.max(32, termWidth - nameWidth - 3)
  );
  const truncate = (text: string) =>
    text.length <= descBudget
      ? text
      : `${text.slice(0, Math.max(1, descBudget - 3)).trimEnd()}...`;
  const line = (row: KnownPersonaRow) =>
    `${row.name.padEnd(nameWidth)} | ${truncate(row.description)}`.trimEnd();
  return [line(headers), ...rendered.map(line)].join('\n');
}

function resolveSpec(key: string): ResolvedTarget['spec'] | { error: string } {
  const localSpec = local.byId.get(key);
  if (localSpec) return localSpec;
  const catalogAsIntent = (personaCatalog as Record<string, PersonaSpec | undefined>)[key];
  if (catalogAsIntent) return catalogAsIntent;
  const byId = listBuiltInPersonas().find((p) => p.id === key);
  if (byId) return byId;

  const packHint =
    'Optional first-party personas are installed from packs, for example:\n' +
    '  agentworkforce install @agentworkforce/personas-core\n' +
    '  agentworkforce install @agentrelay/personas';
  return {
    error: `Unknown persona "${key}". Known personas:\n${formatNameDescriptionTable(collectKnownPersonas())}\n\n${packHint}`
  };
}

function parseSelector(sel: string): ResolvedTarget {
  const at = sel.indexOf('@');
  const key = at === -1 ? sel : sel.slice(0, at);
  const tierRaw = at === -1 ? undefined : sel.slice(at + 1);
  if (!key) die('Missing persona name before "@"');
  if (tierRaw !== undefined && !PERSONA_TIERS.includes(tierRaw as PersonaTier)) {
    die(`Invalid tier "${tierRaw}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
  }
  const result = resolveSpec(key);
  if ('error' in result) die(result.error, false);
  const kind = local.byId.has(key) ? 'local' : 'repo';
  // Resolution order when no @<tier> is given: routingProfiles default for the
  // persona's intent (built-ins only — local personas with custom intents miss
  // the lookup and fall through), then the persona's own defaultTier, then
  // 'best-value'. Mirrors `resolveShowTarget` and the `list` recommended-tier
  // filter so all three commands agree on what "no tier" means.
  const profileRule =
    kind === 'repo'
      ? (routingProfiles.default.intents as Partial<Record<string, { tier: PersonaTier }>>)[
          result.intent
        ]
      : undefined;
  const tier = (tierRaw ?? profileRule?.tier ?? result.defaultTier ?? 'best-value') as PersonaTier;
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

/**
 * Run a skill-install subprocess behind an ora spinner. stdout and stderr are
 * captured so a successful install collapses to a single ✓ line; on failure,
 * the buffered output is dumped after spinner.fail so the user sees what
 * actually broke. stdin is ignored — the install commands don't prompt.
 *
 * Uses async `spawn` (not `spawnSync`) because ora's frame redraw runs on a
 * setInterval — `spawnSync` blocks the event loop for the duration of the
 * install, freezing the spinner on its first frame.
 *
 * The spinner text stays "Installing skills…" while running; the longer
 * `label` (which includes target paths and skill ids) is shown on
 * success/failure so the verbose detail is still discoverable in logs.
 */
async function runInstallWithSpinner(
  command: readonly string[],
  label: string,
  cwd: string | undefined
): Promise<{ code: number; output: string }> {
  const [bin, ...args] = command;
  if (!bin) return { code: 0, output: '' };
  const spinner = ora({ text: 'Installing skills…', stream: process.stderr }).start();
  // Async spawn (not spawnSync) so ora's frame timer can fire during the
  // install — spawnSync blocks the event loop and freezes the spinner on
  // its first frame.
  const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(cwd ? { cwd } : {})
    });
    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      buffered += chunk;
    });
    child.on('error', (err) => {
      resolve({ code: 1, output: `${buffered}${err.message}\n` });
    });
    child.on('close', (status, signal) => {
      const exit =
        typeof status === 'number' ? status : signal ? signalExitCode(signal) : 1;
      resolve({ code: exit, output: buffered });
    });
  });
  if (code === 0) {
    spinner.succeed(label);
  } else {
    spinner.fail(`${label} failed (exit ${code})`);
    if (output.trim()) process.stderr.write(output.endsWith('\n') ? output : `${output}\n`);
  }
  return { code, output };
}

async function runInstall(command: readonly string[], label: string, cwd?: string): Promise<void> {
  const [bin] = command;
  if (!bin) return;
  // runInstallWithSpinner already prints the failure line via spinner.fail;
  // the previous extra "${label} failed … Aborting." write would duplicate it.
  const { code } = await runInstallWithSpinner(command, label, cwd);
  if (code !== 0) process.exit(code);
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
 * Used inside the mount branch's onBeforeLaunch step so mount teardown runs
 * before the error surfaces.
 */
async function runInstallOrThrow(
  command: readonly string[],
  label: string,
  cwd: string
): Promise<void> {
  const [bin] = command;
  if (!bin) return;
  const { code } = await runInstallWithSpinner(command, label, cwd);
  if (code !== 0) {
    throw new InstallCommandError(label, code);
  }
}

/**
 * CLI-side install context shaped like workload-router's `useSelection().install`.
 * Built directly from persona-kit's pure helpers
 * ({@link materializeSkills}, {@link buildInstallArtifacts},
 * {@link buildCleanupArtifacts}) so the spawn flow can keep its own
 * spinner-driven install/cleanup orchestration without importing
 * `useSelection` from `@agentworkforce/workload-router`.
 */
interface CliInstallContext {
  plan: SkillMaterializationPlan;
  command: readonly string[];
  commandString: string;
  cleanupCommand: readonly string[];
  cleanupCommandString: string;
}

function buildInstallContext(
  selection: PersonaSelection,
  options: { installRoot?: string } = {}
): CliInstallContext {
  const plan = materializeSkills(
    selection.skills,
    selection.runtime.harness,
    options.installRoot !== undefined ? { installRoot: options.installRoot } : {}
  );
  const { installCommand, installCommandString } = buildInstallArtifacts(plan);
  const { cleanupCommand, cleanupCommandString } = buildCleanupArtifacts(plan);
  return {
    plan,
    command: installCommand,
    commandString: installCommandString,
    cleanupCommand,
    cleanupCommandString
  };
}

function runCleanup(command: readonly string[], commandString: string): void {
  if (commandString === ':') return;
  const [bin, ...args] = command;
  if (!bin) return;
  spawnSync(bin, args, { stdio: 'inherit', shell: false });
}

/**
 * Remove the whole per-session directory after the run, including the
 * enclosing `<homedir>/.agentworkforce/workforce/sessions/<id>/` that the CLI
 * created. The workload-router cleanup only covers the install subtree
 * (`<root>/claude/plugin`), so without this step empty parent dirs
 * would accumulate under `~/.agentworkforce/workforce/sessions/`.
 *
 * Uses `fs.rmSync` rather than `spawnSync('rm', …)` so the teardown works
 * on Windows where `rm` isn't on PATH.
 */
function removeSessionRoot(sessionRoot: string | undefined): void {
  if (!sessionRoot) return;
  try {
    rmSync(sessionRoot, { recursive: true, force: true });
  } catch {
    /* best-effort — if teardown fails the dir is harmless under ~/.agentworkforce/workforce/sessions */
  }
}

/**
 * Compute the absolute root directory for an interactive claude session.
 * Layout (under `root`):
 *
 *   ~/.agentworkforce/workforce/sessions/<personaId>-<timestamp>-<rand>/
 *     ├── claude/plugin/     ← skill install target + --plugin-dir
 *     └── mount/             ← @relayfile/local-mount mount
 *
 * The timestamp + random suffix keep concurrent sessions from colliding on
 * the same dir. Both the skill-install path and the mount path are derived
 * from the same `root` so a single session ID describes the whole run.
 */
function generateSessionRoot(personaId: string): string {
  const sessionId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return join(homedir(), '.agentworkforce', 'workforce', 'sessions', `${personaId}-${sessionId}`);
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
 * (the opencode branch in persona-kit) emits exactly one pair, so both
 * behaviors are equivalent today, but "remove all" is idempotent and safer if
 * a future caller ever appends a second `--agent` for any reason. A trailing
 * `--agent` with no following value is preserved so the malformed argv
 * surfaces at the harness rather than getting silently swallowed here.
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
  if (harness !== 'claude' && harness !== 'opencode' && harness !== 'codex') return {};
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
  // opencode and codex both read AGENTS.md from cwd. For codex, the mount
  // only engages when a sidecar is declared (see decideCleanMode); without
  // a mount the materialization warning fires. The resolution rule is
  // identical for both harnesses here.
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
 * All three harnesses (claude, codex, opencode) default to the mount.
 * The mount hides CLAUDE.md / .claude / .mcp.json (claude) or the
 * skill-install patterns + AGENTS.md (codex / opencode) so persona-supplied
 * sidecars and any per-session writes stay sandboxed and don't leak into
 * the user's real repo. `--install-in-repo` is the single opt-out that
 * disengages the mount across all harnesses.
 *
 * Pure — no side effects, trivially testable.
 */
export function decideCleanMode(
  harness: Harness,
  installInRepo = false
): { useClean: boolean } {
  if (harness === 'claude' || harness === 'opencode' || harness === 'codex') {
    return { useClean: !installInRepo };
  }
  return { useClean: false };
}

/**
 * Persona authoring dry-run. Used by persona authors to verify a persona
 * actually launches before it ships, without spawning the harness or
 * running the agent's tier model. Three checks, in order:
 *
 *   1. Sidecar resolution — `claudeMd` / `agentsMd` filename references
 *      that point at unreadable files would brick the launch silently
 *      today (lenient warning); dry-run promotes them to failures.
 *   2. Interactive spec build — runs `buildInteractiveSpec` on the
 *      resolved selection. Catches malformed `permissions` patterns,
 *      `mcpServers` shape errors, and missing required harness fields.
 *      Pure / no side effects.
 *   3. Skill install — runs each `skills[].source` through its real
 *      installer (`npx skills add` / `npx prpm install`) inside a fresh
 *      temp dir and reports per-skill pass/fail.
 *
 * Temp dir is deleted on success so dry-run leaves no trace; on a skill
 * failure it is left in place and its path printed so the author can
 * inspect the installer's output. Checks 1 and 2 run before any temp
 * dir is created so an early failure doesn't litter `/tmp`.
 */
function runDryRun(selection: PersonaSelection): number {
  const inputResolution = resolvePersonaInputs(
    selection.inputs,
    selection.inputValues,
    process.env
  );
  const renderedSystemPrompt = renderPersonaInputs(
    selection.runtime.systemPrompt,
    inputResolution.values
  );
  const renderedClaudeContent =
    selection.claudeMdContent !== undefined
      ? renderPersonaInputs(selection.claudeMdContent, inputResolution.values)
      : undefined;
  const renderedAgentsContent =
    selection.agentsMdContent !== undefined
      ? renderPersonaInputs(selection.agentsMdContent, inputResolution.values)
      : undefined;
  const effectiveSelection: PersonaSelection = {
    ...selection,
    runtime: { ...selection.runtime, systemPrompt: renderedSystemPrompt },
    ...(renderedClaudeContent !== undefined ? { claudeMdContent: renderedClaudeContent } : {}),
    ...(renderedAgentsContent !== undefined ? { agentsMdContent: renderedAgentsContent } : {})
  };
  const { runtime, personaId, tier } = effectiveSelection;

  process.stderr.write(
    `→ ${personaId} [${tier}] via ${runtime.harness} (${runtime.model}) [DRY-RUN]\n`
  );

  // Check 1: sidecar resolution. A loadSidecarForSelection warning means
  // the persona points `claudeMd` / `agentsMd` at a file we couldn't
  // read; the launch path degrades to a warning today, which silently
  // drops the persona's operating spec. In dry-run that's a failure.
  const sidecarLookup = loadSidecarForSelection(effectiveSelection);
  if (sidecarLookup.warning) {
    process.stderr.write(`✗ sidecar: ${sidecarLookup.warning}\n`);
    return 1;
  }
  process.stderr.write(
    `✓ sidecar: ${sidecarLookup.sidecar ? sidecarLookup.sidecar.mountFile : '(none)'}\n`
  );

  // Check 2: persona-kit translation. buildInteractiveSpec validates
  // permissions shape, mcpServers shape, and required runtime fields.
  // We resolve env + mcp leniently (same as the live launch path) so
  // the spec call sees the same inputs it would at runtime.
  const callerEnv = { ...process.env, ...inputResolution.values };
  const envResolution = resolveStringMapLenient(effectiveSelection.env, callerEnv, 'env');
  const mcpResolution = resolveMcpServersLenient(effectiveSelection.mcpServers, callerEnv);
  emitDropWarnings(
    formatDropWarnings(envResolution.dropped, mcpResolution.dropped, mcpResolution.droppedServers)
  );
  let spec: InteractiveSpec;
  try {
    spec = buildInteractiveSpec({
      harness: runtime.harness,
      personaId,
      model: runtime.model,
      systemPrompt: runtime.systemPrompt,
      harnessSettings: runtime.harnessSettings,
      mcpServers: mcpResolution.servers,
      permissions: effectiveSelection.permissions
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ harness spec: ${msg}\n`);
    return 1;
  }
  for (const w of spec.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stderr.write(`✓ harness spec: ${spec.bin} (${spec.args.length} args)\n`);

  // Check 3: skill installs.
  const plan = materializeSkills(effectiveSelection.skills, runtime.harness);
  if (plan.installs.length === 0) {
    process.stderr.write('✓ skills: (none declared)\n');
    process.stderr.write('✓ dry-run ok\n');
    return 0;
  }

  const tempDir = mkdtempSync(join(tmpdir(), `agentworkforce-dryrun-${personaId}-`));
  process.stderr.write(`• temp dir: ${tempDir}\n`);
  process.stderr.write(`• installing ${plan.installs.length} skill(s)\n`);

  const failures: { skillId: string; exitCode: number }[] = [];
  for (const inst of plan.installs) {
    const [bin, ...args] = inst.installCommand;
    if (!bin) {
      process.stderr.write(`  skipped ${inst.skillId}: empty install command\n`);
      continue;
    }
    process.stderr.write(`• ${inst.skillId} (${inst.sourceKind}) → ${inst.packageRef}\n`);
    const res = spawnSync(bin, args, { stdio: 'inherit', shell: false, cwd: tempDir });
    const code = subprocessExitCode(res);
    if (code === 0) {
      process.stderr.write(`  ✓ ${inst.skillId}\n`);
    } else {
      process.stderr.write(`  ✗ ${inst.skillId} (exit ${code})\n`);
      failures.push({ skillId: inst.skillId, exitCode: code });
    }
  }

  if (failures.length === 0) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: failed to clean up ${tempDir}: ${msg}\n`);
    }
    process.stderr.write(
      `✓ dry-run ok: ${plan.installs.length} skill(s) installed cleanly\n`
    );
    return 0;
  }

  process.stderr.write(
    `✗ dry-run failed: ${failures.length} of ${plan.installs.length} skill(s) failed\n`
  );
  process.stderr.write(`  inspect ${tempDir} for installer output\n`);
  for (const f of failures) {
    process.stderr.write(`  - ${f.skillId} (exit ${f.exitCode})\n`);
  }
  return failures[0]?.exitCode || 1;
}

/**
 * Optional out-parameter populated by `runInteractive` so the caller can
 * locate the just-ended session for follow-up tooling (e.g. the
 * persona-improver post-session prompt). Populated regardless of exit
 * status so failure paths are still inspectable.
 */
interface RunInteractiveCapture {
  /** Cwd the harness child saw — mount dir for sandboxed sessions, real cwd otherwise. */
  sessionCwd?: string;
  /** Harness binary that was spawned. */
  harness?: Harness;
  /** Wallclock (ms) right before the harness child was spawned. Used to filter newer transcript files. */
  startedAt?: number;
  /**
   * Burn-stamp enrichment written by launch-metadata (`agentworkforce`,
   * `persona`, `personaVersion`, `personaTier`, `personaSource`). Empty
   * `{}` when launch-metadata is disabled (opt-out via env or backend
   * doesn't support stamps). Lets the post-session lookup match the
   * just-ended session to its harness sessionId via `exportStamps`.
   */
  stampEnrichment?: Record<string, string>;
  /** Whether burn stamping was actually wired this run (false → exportStamps lookup is moot). */
  stampingEnabled?: boolean;
}

async function runInteractive(
  selection: PersonaSelection,
  options: {
    installInRepo?: boolean;
    noLaunchMetadata?: boolean;
    personaSpec: PersonaSpec;
    personaSource: PersonaSource;
    capture?: RunInteractiveCapture;
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
  // Render input placeholders ($TARGET_DIR, ${CREATE_MODE}, …) inside the
  // sidecar Content fields too. Personas that move heavy authoring guidance
  // out of the systemPrompt and into AGENTS.md / CLAUDE.md still want
  // their declared inputs interpolated; without this the materialized
  // sidecar would carry literal `$TARGET_DIR` strings.
  const renderedClaudeContent =
    selection.claudeMdContent !== undefined
      ? renderPersonaInputs(selection.claudeMdContent, inputResolution.values)
      : undefined;
  const renderedAgentsContent =
    selection.agentsMdContent !== undefined
      ? renderPersonaInputs(selection.agentsMdContent, inputResolution.values)
      : undefined;
  const effectiveSelection: PersonaSelection = {
    ...selection,
    runtime: {
      ...selection.runtime,
      systemPrompt: renderedSystemPrompt
    },
    ...(renderedClaudeContent !== undefined ? { claudeMdContent: renderedClaudeContent } : {}),
    ...(renderedAgentsContent !== undefined ? { agentsMdContent: renderedAgentsContent } : {})
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
  // file is materialized into the mount inside onBeforeLaunch. Without a
  // mount (--install-in-repo) we skip-and-warn — writing into the real cwd
  // would pollute the user's repo and is explicitly out of scope.
  const sidecarLookup = loadSidecarForSelection(effectiveSelection);
  if (sidecarLookup.warning) {
    process.stderr.write(`warning: ${sidecarLookup.warning}\n`);
  }
  const resolvedSidecar = useClean ? sidecarLookup.sidecar : undefined;
  if (sidecarLookup.sidecar && !useClean) {
    process.stderr.write(
      `warning: persona declares ${sidecarLookup.sidecar.mountFile} but no sandbox mount is available ` +
        `(--install-in-repo disengages the mount); skipping sidecar materialization to avoid writing into your repo.\n`
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
  const install = buildInstallContext(
    effectiveSelection,
    installRoot !== undefined ? { installRoot } : {}
  );
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
  // valid target even for skill-less local personas. Gate on the
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
    await runInstall(install.command, installLabel);
  }

  const spec = buildInteractiveSpec({
    harness: runtime.harness,
    personaId,
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    harnessSettings: runtime.harnessSettings,
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
    // Setup spinner covers createMount + git-config + (optional) in-mount
    // install + config-file writes + autosync start, so the multi-second
    // pause before the harness child appears is visibly live. createMount
    // is async in @relayfile/local-mount ≥0.7.0, which yields between
    // directory entries — so this spinner actually animates instead of
    // freezing on its first frame.
    let setupSpinner: Ora | undefined = ora({
      text: `Setting up sandbox mount → ${mountDir}…`,
      stream: process.stderr
    }).start();
    // Inline mount lifecycle (formerly delegated to launchOnMount) so we can
    // surface a spinner the moment the child exits — not just when the user
    // presses Ctrl-C. The sync-back walks both trees and can take several
    // seconds on a large repo; without an indicator, exiting the persona via
    // /exit looked like a hang.
    //
    // SIGINT semantics — three phases:
    //   • Pre-launch (setup): tear down the setup spinner, rm the session
    //     dir, and exit(130). We must handle this ourselves because
    //     registering any 'SIGINT' listener suppresses Node's default
    //     exit-on-SIGINT, and createMount is now async (relayfile 0.7+) so
    //     the handler actually fires during mount setup.
    //   • Child running: Ctrl-C reaches the harness directly via the
    //     controlling TTY's foreground process group (the child is spawned
    //     with `stdio: 'inherit'` and inherits the parent's pgid). We
    //     no-op purely to suppress Node's default exit — forwarding via
    //     child.kill('SIGINT') would deliver a *second* SIGINT and break
    //     harnesses that escalate on repeated interrupts (e.g. claude
    //     treats 1st = cancel, 2nd = quit).
    //   • Syncing (post-child): 1st press aborts the shutdownSignal
    //     (relayfile then skips autosync's draining reconcile and returns
    //     the partial count from the final syncBack). 2nd press hard-exits
    //     and rms the session dir so no mount is left behind.
    const shutdownController = new AbortController();
    let syncSpinner: Ora | undefined;
    let isSyncing = false;
    let childSpawned = false;
    let abortPresses = 0;
    const sigintHandler = () => {
      if (!isSyncing) {
        if (childSpawned) return;
        // Pre-launch teardown.
        if (setupSpinner) {
          setupSpinner.fail('Sandbox mount setup interrupted (Ctrl-C)');
          setupSpinner = undefined;
        }
        try {
          rmSync(sessionRoot, { recursive: true, force: true });
        } catch {
          /* swallow — we're exiting anyway */
        }
        process.exit(130);
      }
      abortPresses += 1;
      if (abortPresses === 1) {
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
      try {
        rmSync(sessionRoot, { recursive: true, force: true });
      } catch {
        /* swallow — we're exiting anyway */
      }
      process.exit(130);
    };
    process.on('SIGINT', sigintHandler);

    let handle: Awaited<ReturnType<typeof createMount>> | undefined;
    let autoSync: AutoSyncHandle | undefined;
    let exitCode = 0;
    try {
      // createMount inside the try so its initial-mirror failures fall into
      // the catch path and clean up the setup spinner.
      handle = await createMount(process.cwd(), mountDir, {
        ignoredPatterns: [...ignoredPatterns],
        readonlyPatterns: [...readonlyPatterns],
        excludeDirs: [],
        agentName: personaId,
        // Pull `.git` into the mount so git commands work inside the
        // sandbox. relayfile treats this as one-way project→mount: host-side
        // `.git` changes flow in, mount-side commits/refs stay sandboxed and
        // are discarded on cleanup. The agent must `git push` to persist
        // work.
        includeGit: true
      });
      // Run before install / configFile writes so the freshly written files
      // (e.g. `.opencode/`, `opencode.json`) aren't yet present when we run
      // `git ls-files` to pick skip-worktree candidates — we don't need them
      // flagged in the index, just hidden via the `.git/info/exclude` block.
      configureGitForMount(handle.mountDir, ignoredPatterns);
      if (deferInstallToMount) {
        // Hand the line off to the install spinner so the two don't fight
        // for the same stream, then resume the setup spinner afterwards.
        setupSpinner?.stop();
        await runInstallOrThrow(install.command, installLabel, handle.mountDir);
        setupSpinner?.start();
      }
      for (const file of spec.configFiles) {
        assertSafeRelativePath(file.path);
        const target = join(handle.mountDir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.contents, 'utf8');
      }
      if (resolvedSidecar) {
        const body = buildSidecarBody(resolvedSidecar, process.cwd());
        writeFileSync(join(handle.mountDir, resolvedSidecar.mountFile), body, 'utf8');
      }
      launchMetadata = await startLaunchMetadataForLaunch(handle.mountDir);
      if (options.capture) {
        options.capture.stampEnrichment = { ...launchMetadata.metadata };
        options.capture.stampingEnabled = launchMetadata.enabled;
      }

      autoSync = handle.startAutoSync();

      // Stop the setup spinner before spawning the child — the child
      // inherits stdio and would otherwise interleave its output with
      // spinner frames.
      setupSpinner?.succeed(`Sandbox mount ready → ${mountDir}`);
      setupSpinner = undefined;

      const childEnv = resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env;
      const childCwd = handle.mountDir;
      if (options.capture) {
        options.capture.sessionCwd = childCwd;
        options.capture.harness = runtime.harness;
        options.capture.startedAt = Date.now();
      }
      // Flip the SIGINT phase flag before spawn so a Ctrl-C arriving during
      // the child's lifetime is treated as "child has the TTY" (no-op),
      // not as pre-launch teardown.
      childSpawned = true;
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(spec.bin, finalArgs, {
          cwd: childCwd,
          stdio: 'inherit',
          env: childEnv
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (typeof code === 'number') resolve(code);
          else if (signal) resolve(signalExitCode(signal));
          else resolve(1);
        });
      });

      // Child exited — start the spinner immediately so the sync-back is
      // visibly live rather than a silent pause.
      isSyncing = true;
      syncSpinner = ora({
        text: 'Syncing session changes back to the repo… (Ctrl-C to skip)',
        stream: process.stderr
      }).start();

      let count = 0;
      if (autoSync) {
        await autoSync.stop({ signal: shutdownController.signal });
        count += autoSync.totalChanges();
        autoSync = undefined;
      }
      // NOTE: `count` is bidirectional — it sums autosync activity in both
      // directions (inbound project→mount and outbound mount→project,
      // including deletes) plus the final mount→project syncBack. Phrase as
      // "file events during session" so we don't overclaim direction.
      count += await handle.syncBack({ signal: shutdownController.signal });

      const aborted = shutdownController.signal.aborted;
      const qualifier = aborted ? ' (partial)' : '';
      const message =
        count > 0
          ? `Session complete — ${count} file event${count === 1 ? '' : 's'} during session${qualifier}.`
          : 'Session complete — no file events.';
      syncSpinner.succeed(message);
      syncSpinner = undefined;
      return exitCode;
    } catch (err) {
      if (setupSpinner) {
        setupSpinner.fail('Sandbox mount setup failed');
        setupSpinner = undefined;
      }
      if (syncSpinner) {
        syncSpinner.fail('Sync did not complete');
        syncSpinner = undefined;
      }
      // InstallCommandError carries the real install exit code — surfacing
      // it (rather than collapsing onto 127) lets callers distinguish a
      // failed `npx prpm install` from a missing harness binary. The message
      // itself was already shown via spinner.fail inside runInstallWithSpinner,
      // so we just return the code here.
      if (err instanceof InstallCommandError) {
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
      if (setupSpinner) {
        setupSpinner.stop();
        setupSpinner = undefined;
      }
      if (syncSpinner) {
        syncSpinner.stop();
        syncSpinner = undefined;
      }
      // Best-effort: stop autosync if we errored out before the success path
      // already cleared it.
      if (autoSync) {
        try {
          await autoSync.stop({ signal: shutdownController.signal });
        } catch {
          /* ignore — we're tearing down anyway */
        }
      }
      handle?.cleanup();
      await launchMetadata?.stop();
      process.removeListener('SIGINT', sigintHandler);
      // When the install ran inside the mount, its cleanup paths are
      // mount-relative (e.g. `.skills/<name>`, `skills/<name>`) and running
      // cleanup here would resolve them against the real repo cwd —
      // potentially `rm -rf`ing pre-existing user content. The mount dir is
      // removed wholesale by `removeSessionRoot` below, so the install's
      // cleanup is redundant anyway in that case.
      if (!deferInstallToMount) {
        runCleanup(install.cleanupCommand, install.cleanupCommandString);
      }
      removeSessionRoot(sessionRoot);
    }
  }

  const launchMetadata = await startLaunchMetadataForLaunch();
  if (options.capture) {
    options.capture.sessionCwd = process.cwd();
    options.capture.harness = runtime.harness;
    options.capture.startedAt = Date.now();
    options.capture.stampEnrichment = { ...launchMetadata.metadata };
    options.capture.stampingEnabled = launchMetadata.enabled;
  }
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
  defaultTier: PersonaTier | undefined;
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
        rating: tier,
        defaultTier: spec.defaultTier
      });
    }
  };
  const seen = new Set<string>();
  for (const [id, spec] of local.byId) {
    pushSpec(spec, local.sources.get(id) ?? 'library');
    seen.add(id);
  }
  for (const spec of listBuiltInPersonas()) {
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
      const rule = (recommendedByIntent as Partial<Record<string, { tier: PersonaTier }>>)[r.intent];
      if (r.rating !== (rule?.tier ?? r.defaultTier ?? 'best-value')) return false;
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
    const byIntent = (personaCatalog as Record<string, PersonaSpec | undefined>)[key];
    if (byIntent) {
      spec = byIntent;
    } else {
      const byId = listBuiltInPersonas().find((p) => p.id === key);
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
    const rule = (routingProfiles.default.intents as Partial<Record<string, { tier: PersonaTier }>>)[spec.intent];
    tiers = [rule?.tier ?? spec.defaultTier ?? 'best-value'];
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
  if (spec.defaultTier) {
    lines.push(`DEFAULT TIER ${spec.defaultTier}`);
  }
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
    if (rt.harnessSettings.sandboxMode) {
      lines.push(`  sandbox:  ${rt.harnessSettings.sandboxMode}`);
    }
    if (rt.harnessSettings.approvalPolicy) {
      lines.push(`  approvals: ${rt.harnessSettings.approvalPolicy}`);
    }
    if (rt.harnessSettings.workspaceWriteNetworkAccess !== undefined) {
      lines.push(`  network:  ${rt.harnessSettings.workspaceWriteNetworkAccess}`);
    }
    if (rt.harnessSettings.webSearch !== undefined) {
      lines.push(`  webSearch: ${rt.harnessSettings.webSearch}`);
    }
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
  return loadPersonaSourceConfig().defaultCreateTarget ?? 'cwd';
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
        'create: --save-in-directory=library requires running from the AgentWorkforce repo root, where ./personas exists.'
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
  recordRecent(target.spec.id);
  const selection = {
    ...buildSelection(target.spec, target.tier, target.kind),
    ...(inputValues ? { inputValues } : {})
  };

  if (flags.dryRun) {
    const code = runDryRun(selection);
    process.exit(code);
  }

  const capture: RunInteractiveCapture = {};
  const code = await runInteractive(selection, {
    installInRepo: flags.installInRepo,
    noLaunchMetadata: flags.noLaunchMetadata,
    personaSpec: target.spec,
    personaSource: target.source,
    capture
  });
  // Post-session learnings prompt: only for local personas (built-in
  // catalog and pack personas are read-only here), and only when stdin
  // is a TTY so we can read y/N. Improver failures never affect the
  // user-facing exit code — the original session's exit is what matters.
  await maybeOfferLearningsImprover({
    target,
    capture,
    flags
  });
  process.exit(code);
}

interface LocalPersonaImproverContext {
  target: ResolvedTarget;
  capture: RunInteractiveCapture;
  flags: AgentFlags;
}

/**
 * Decide whether to offer post-session auto-improvement, run the improver,
 * walk the proposals interactively, and apply accepted patches. Silently
 * skips the prompt when the persona is built-in or stdin is not a TTY.
 *
 * Failures (improver crash, malformed proposals JSON, unwriteable persona
 * file) are surfaced as warnings on stderr; they never throw or change
 * the original session's exit code. The user already saw their session
 * complete — a flaky meta-step shouldn't mask that.
 */
async function maybeOfferLearningsImprover(ctx: LocalPersonaImproverContext): Promise<void> {
  if (ctx.target.kind !== 'local') return;
  if (ctx.target.source === 'library') return;
  const personaFilePath = local.paths.get(ctx.target.spec.id);
  if (!personaFilePath) {
    // No on-disk path means we can't apply patches even if the user agrees.
    // Skip silently — local-personas would have warned at load time.
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) return;
  const personaId = ctx.target.spec.id;
  const wantsImprover = promptYesNoSync(
    `\nAuto-improve "${personaId}" from this session? [y/N] `
  );
  if (!wantsImprover) return;

  let transcriptPath = '';
  try {
    if (ctx.capture.stampingEnabled && ctx.capture.stampEnrichment) {
      transcriptPath =
        (await findSessionTranscriptViaStamps({
          harness: ctx.capture.harness,
          sessionCwd: ctx.capture.sessionCwd,
          enrichment: ctx.capture.stampEnrichment,
          startedAt: ctx.capture.startedAt
        })) ?? '';
    }
    if (!transcriptPath) {
      transcriptPath =
        findSessionTranscriptPath({
          harness: ctx.capture.harness,
          sessionCwd: ctx.capture.sessionCwd,
          startedAt: ctx.capture.startedAt
        }) ?? '';
    }
  } catch (err) {
    process.stderr.write(
      `warning: could not locate session transcript: ${(err as Error).message}\n`
    );
  }
  if (!transcriptPath) {
    process.stderr.write(
      `note: session transcript not found for harness "${ctx.capture.harness ?? '?'}" — proceeding from persona file alone.\n`
    );
  }

  let proposals: ImproverProposalsFile | undefined;
  const proposalsTempPath = join(
    tmpdir(),
    `agentworkforce-proposals-${randomBytes(6).toString('hex')}.json`
  );
  const spinner = ora({
    text: 'Extracting learnings via persona-improver…',
    stream: process.stderr
  }).start();
  try {
    proposals = await runPersonaImprover({
      personaFilePath,
      transcriptPath,
      proposalsOutputPath: proposalsTempPath
    });
    spinner.succeed(
      proposals.proposals.length === 0
        ? 'persona-improver: no improvements to propose.'
        : `persona-improver: found ${proposals.proposals.length} proposed improvement${proposals.proposals.length === 1 ? '' : 's'}.`
    );
  } catch (err) {
    spinner.fail(`persona-improver failed: ${(err as Error).message}`);
    return;
  } finally {
    try {
      rmSync(proposalsTempPath, { force: true });
    } catch {
      /* swallow — temp file in $TMPDIR is harmless */
    }
  }
  if (!proposals || proposals.proposals.length === 0) return;

  const accepted = walkProposalsInteractive(proposals);
  if (accepted.length === 0) {
    process.stderr.write('No improvements applied.\n');
    return;
  }
  try {
    applyAcceptedPatches(personaFilePath, accepted);
    process.stderr.write(
      `✓ Applied ${accepted.length} improvement${accepted.length === 1 ? '' : 's'} to ${personaFilePath}\n`
    );
  } catch (err) {
    process.stderr.write(
      `warning: failed to write updated persona to ${personaFilePath}: ${(err as Error).message}\n`
    );
  }
}

export interface ImproverPatch {
  path: string;
  op: 'set' | 'append';
  value: unknown;
}

/**
 * Allowlist of dot-paths the improver may rewrite via `op: "set"`. Mirrors
 * the patch grammar advertised in the persona's AGENTS.md — anything else
 * is a defense-in-depth reject (the persona's anti-goals already say "no
 * changes to id/intent/harness/model/permissions", but we don't trust the
 * model alone for a flow that mutates the user's persona file in place).
 */
const ALLOWED_SET_PATHS: readonly string[] = [
  'description',
  'agentsMdContent',
  'claudeMdContent',
  'tags',
  'tiers.best.systemPrompt',
  'tiers.best-value.systemPrompt',
  'tiers.minimum.systemPrompt'
];

/**
 * Allowlist of dot-paths the improver may rewrite via `op: "append"`.
 * Currently just `skills` — the only array the AGENTS.md grammar exposes
 * for append-style mutation.
 */
const ALLOWED_APPEND_PATHS: readonly string[] = ['skills'];

/**
 * Reserved JSON-object keys that must never appear as a path segment —
 * setting them would either pollute the prototype chain (`__proto__`,
 * `constructor`, `prototype`) for the running process or rewrite a
 * built-in property that downstream code relies on. Belt-and-braces
 * alongside the path allowlist; even an `inputs.<NAME>` segment can't
 * smuggle one of these in.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafePathSegments(path: string, context: string): readonly string[] {
  const segments = path.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`${context}: path is empty`);
  }
  for (const seg of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) {
      throw new Error(
        `${context}: path "${path}" contains forbidden segment "${seg}"`
      );
    }
  }
  return segments;
}

/**
 * Validate one improver patch against the path/op allowlist + the
 * prototype-segment guard. Throws a descriptive error rejected at parse
 * time so the CLI never offers a disallowed proposal to the user.
 *
 * Allowed set paths: see ALLOWED_SET_PATHS, plus any `inputs.<NAME>`
 * (NAME must be env-style, matching the persona-input naming rule).
 * Allowed append paths: see ALLOWED_APPEND_PATHS.
 */
function assertAllowedImproverPatch(patch: ImproverPatch, context: string): void {
  assertSafePathSegments(patch.path, context);
  if (patch.op === 'set') {
    if (ALLOWED_SET_PATHS.includes(patch.path)) return;
    if (patch.path.startsWith('inputs.')) {
      const after = patch.path.slice('inputs.'.length);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(after)) {
        throw new Error(
          `${context}: inputs path "${patch.path}" must use an env-style NAME (got "${after}")`
        );
      }
      return;
    }
    throw new Error(`${context}: set path "${patch.path}" is not in the allowlist`);
  }
  if (patch.op === 'append') {
    if (!ALLOWED_APPEND_PATHS.includes(patch.path)) {
      throw new Error(
        `${context}: append path "${patch.path}" is not in the allowlist`
      );
    }
    return;
  }
  throw new Error(`${context}: unknown patch op "${(patch as { op: string }).op}"`);
}

export interface ImproverProposal {
  id: string;
  summary: string;
  rationale: string;
  patches: ImproverPatch[];
}

export interface ImproverProposalsFile {
  personaId: string;
  personaFilePath: string;
  transcriptPath: string;
  proposals: ImproverProposal[];
}

/**
 * Locate the just-ended session's transcript via the burn-stamp ledger.
 * Authoritative when stamping is wired: `launch-metadata.ts` writes a
 * pending stamp (with our `personaVersion` enrichment hash) before spawn
 * and runs `ingest` on a 1s tick + once at stop, so by the time we get
 * here the ledger already has a row whose `selector.sessionId` is the
 * harness's own session id. We filter by `persona` + `personaVersion`
 * (unique per persona spec hash) and `ts` near `startedAt` to avoid
 * picking up a sibling launch of the same persona, then resolve the
 * sessionId to a transcript file path per harness.
 *
 * Returns undefined when:
 *   - the SDK call fails
 *   - no row matches (ingest hasn't reconciled yet, or stamping is off)
 *   - the resolved sessionId can't be located on disk
 * Caller falls back to `findSessionTranscriptPath` (cwd-content match).
 */
async function findSessionTranscriptViaStamps(input: {
  harness?: Harness;
  sessionCwd?: string;
  enrichment: Record<string, string>;
  startedAt?: number;
}): Promise<string | undefined> {
  if (!input.harness || !input.sessionCwd) return undefined;
  const persona = input.enrichment.persona;
  const personaVersion = input.enrichment.personaVersion;
  if (!persona || !personaVersion) return undefined;
  let sdk: typeof import('@relayburn/sdk');
  try {
    sdk = await import('@relayburn/sdk');
  } catch {
    return undefined;
  }
  if (typeof sdk.exportStamps !== 'function') return undefined;
  let rows: unknown[];
  try {
    rows = await sdk.exportStamps();
  } catch {
    return undefined;
  }
  const startedAt = input.startedAt ?? 0;
  const spawnerPid = input.enrichment.spawnerPid;
  // Tight window around our session: stamps written before our spawn
  // (minus tolerance for clock skew) or after the prompt fires (plus
  // tolerance for ingest latency) can't be ours. The upper bound matters
  // when a sibling launch of the same persona starts AFTER ours but
  // before we get here — without it, max-ts wins picks the wrong row.
  const LOWER_TOLERANCE_MS = 5000;
  const UPPER_TOLERANCE_MS = 1000;
  const lowerMs = startedAt - LOWER_TOLERANCE_MS;
  const upperMs = Date.now() + UPPER_TOLERANCE_MS;
  let bestSessionId: string | undefined;
  // Prefer the stamp closest to our spawn time (smallest |ts - startedAt|),
  // not the most recent. Same-persona concurrent launches can both fall
  // inside the window; the one launched at our PID/time is the right one.
  let bestDelta = Number.POSITIVE_INFINITY;
  let pidMatched = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as {
      ts?: unknown;
      selector?: { sessionId?: unknown };
      enrichment?: Record<string, unknown>;
    };
    const sessionId = r.selector?.sessionId;
    const enrichment = r.enrichment;
    const ts = r.ts;
    if (typeof sessionId !== 'string' || !enrichment || typeof ts !== 'string') continue;
    if (enrichment.persona !== persona) continue;
    if (enrichment.personaVersion !== personaVersion) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < lowerMs || tsMs > upperMs) continue;
    // spawnerPid is the strongest discriminator — folded into enrichment
    // by `buildLaunchMetadata` so it survives stamp ingest. When present
    // on both sides, treat a mismatch as a hard reject and a match as
    // sticky: once we've seen a pid-matched row, ignore unmatched ones
    // even if they're closer in time.
    const rowPid = enrichment.spawnerPid;
    if (spawnerPid && typeof rowPid === 'string') {
      if (rowPid !== spawnerPid) continue;
      if (!pidMatched) {
        pidMatched = true;
        bestDelta = Number.POSITIVE_INFINITY;
        bestSessionId = undefined;
      }
    } else if (pidMatched) {
      // We already locked onto pid-matched candidates — skip non-pid rows.
      continue;
    }
    const delta = Math.abs(tsMs - startedAt);
    if (delta >= bestDelta) continue;
    bestDelta = delta;
    bestSessionId = sessionId;
  }
  if (!bestSessionId) return undefined;
  return resolveTranscriptForSessionId(input.harness, input.sessionCwd, bestSessionId);
}

/**
 * Map a harness session id to its on-disk transcript file. The directory
 * is harness-conventional, but the filename pattern varies:
 *   • claude    → `<sessionId>.jsonl` directly under the cwd-encoded subdir
 *   • codex     → `rollout-<ts>-<sessionId>.jsonl` under a date-grouped subdir
 *   • opencode  → file or filename containing the sessionId under `<projectHash>/`
 *
 * For codex/opencode we scan once and match by filename substring (cheap;
 * the substring is a UUID-ish so collisions don't happen in practice).
 */
function resolveTranscriptForSessionId(
  harness: Harness,
  sessionCwd: string,
  sessionId: string
): string | undefined {
  const home = homedir();
  if (harness === 'claude') {
    const encoded = sessionCwd.replace(/[\\/]+/g, '-');
    const candidate = join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : undefined;
  }
  if (harness === 'codex') {
    return findFileByNameSubstring(join(home, '.codex', 'sessions'), sessionId, ['.jsonl']);
  }
  if (harness === 'opencode') {
    return findFileByNameSubstring(
      join(home, '.local', 'share', 'opencode', 'storage', 'session'),
      sessionId,
      ['.json']
    );
  }
  return undefined;
}

function findFileByNameSubstring(
  dir: string,
  needle: string,
  extensions: readonly string[]
): string | undefined {
  const wantsExt = (name: string) => extensions.some((ext) => name.endsWith(ext));
  const visit = (cur: string, depth: number): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) {
          const found = visit(full, depth + 1);
          if (found) return found;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!wantsExt(entry.name)) continue;
      if (entry.name.includes(needle)) return full;
    }
    return undefined;
  };
  return visit(dir, 0);
}

/**
 * Fallback locator when the burn-stamp ledger is unavailable or the
 * just-ended session hasn't reconciled yet. Walks the harness's
 * transcript dir and verifies each candidate's embedded cwd matches the
 * captured session cwd. Every harness embeds the session cwd:
 *   • claude    → `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl` —
 *                 each entry carries `"cwd"`. The dir-name encoding
 *                 replaces `/` with `-` and is itself a strong filter.
 *   • codex     → `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — first
 *                 line is a `session_meta` event with `payload.cwd`.
 *   • opencode  → `~/.local/share/opencode/storage/session/<projectHash>/<sessionId>.json`
 *                 — top-level `directory` field on the session object.
 *
 * For each harness we walk the candidate dir, filter to files with
 * mtime ≥ sessionStart, and confirm the embedded cwd matches the captured
 * session cwd. Among matches we pick the most recently mtime'd. The cwd
 * confirmation makes this robust to concurrent harness sessions — the
 * caveat that previously applied to codex/opencode (most-recent-mtime
 * could pick a sibling) goes away when we read the file's own cwd.
 *
 * Returns undefined when nothing matches; callers handle gracefully (the
 * persona-improver accepts an empty transcript path).
 */
function findSessionTranscriptPath(input: {
  harness?: Harness;
  sessionCwd?: string;
  startedAt?: number;
}): string | undefined {
  if (!input.harness || !input.sessionCwd) return undefined;
  const startedAt = input.startedAt ?? 0;
  const cwd = input.sessionCwd;
  const home = homedir();
  if (input.harness === 'claude') {
    const encoded = cwd.replace(/[\\/]+/g, '-');
    const projectDir = join(home, '.claude', 'projects', encoded);
    // Within the cwd-encoded dir, all candidates already share the cwd —
    // mtime is enough. We still verify the first-line `cwd` so a stale
    // dir-name match can't smuggle in a wrong file.
    return findFreshestMatchingTranscript({
      dir: projectDir,
      recursive: false,
      extensions: ['.jsonl'],
      sinceMs: startedAt,
      sessionCwd: cwd,
      readCwd: readCwdFromClaudeJsonl
    });
  }
  if (input.harness === 'codex') {
    return findFreshestMatchingTranscript({
      dir: join(home, '.codex', 'sessions'),
      recursive: true,
      extensions: ['.jsonl'],
      sinceMs: startedAt,
      sessionCwd: cwd,
      readCwd: readCwdFromCodexJsonl
    });
  }
  if (input.harness === 'opencode') {
    return findFreshestMatchingTranscript({
      dir: join(home, '.local', 'share', 'opencode', 'storage', 'session'),
      recursive: true,
      extensions: ['.json'],
      sinceMs: startedAt,
      sessionCwd: cwd,
      readCwd: readCwdFromOpencodeSession
    });
  }
  return undefined;
}

interface FindMatchingOptions {
  dir: string;
  /** Whether to walk subdirectories (codex date-grouped, opencode project-hash-grouped). */
  recursive: boolean;
  extensions: readonly string[];
  sinceMs: number;
  sessionCwd: string;
  /**
   * Extract the embedded cwd from the candidate file. Returns undefined
   * when the file has no parseable cwd (skip rather than match).
   */
  readCwd: (path: string) => string | undefined;
}

/**
 * Walk a candidate directory and pick the most recently modified file
 * whose embedded cwd matches `sessionCwd`. Capped at depth 3 in
 * recursive mode — codex/opencode group by date or project hash, never
 * deeper. mtime gate eliminates files written before the session and
 * keeps the scan cheap on large session stores.
 */
function findFreshestMatchingTranscript(opts: FindMatchingOptions): string | undefined {
  const wantsExt = (name: string) => opts.extensions.some((ext) => name.endsWith(ext));
  let bestPath: string | undefined;
  let bestMtime = -1;
  const visit = (cur: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (opts.recursive && depth < 3) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!wantsExt(entry.name)) continue;
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      const mtime = s.mtimeMs;
      if (mtime < opts.sinceMs) continue;
      if (mtime <= bestMtime) continue;
      const cwd = opts.readCwd(full);
      if (cwd !== opts.sessionCwd) continue;
      bestMtime = mtime;
      bestPath = full;
    }
  };
  visit(opts.dir, 0);
  return bestPath;
}

/**
 * Read up to ~64KB from `path` (enough for a JSONL header line plus
 * margin) and return it as a string. Used by the per-harness cwd
 * extractors so we don't slurp multi-megabyte transcripts to find a
 * field on line 1.
 */
interface TranscriptHeader {
  text: string;
  /** True if the file was longer than `maxBytes` and we only read the prefix. */
  truncated: boolean;
}

/**
 * Read up to `maxBytes` from `path` and report whether the file was
 * larger. Callers that need to JSON.parse the whole file (opencode's
 * single-object session record) gate on `truncated === false`; callers
 * that scan line-by-line (claude/codex JSONL) ignore it.
 */
function readTranscriptHeader(
  path: string,
  maxBytes = 65536
): TranscriptHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return {
      text: buf.subarray(0, n).toString('utf8'),
      truncated: n >= maxBytes
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* swallow — fd already invalid */
      }
    }
  }
}

/** Claude JSONL: `cwd` appears on most entries; the first line that has it wins. */
function readCwdFromClaudeJsonl(path: string): string | undefined {
  const header = readTranscriptHeader(path);
  if (!header) return undefined;
  for (const line of header.text.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === 'string') return obj.cwd;
    } catch {
      // partial last line — skip
    }
  }
  return undefined;
}

/** Codex JSONL: line 1 is `session_meta` with `payload.cwd`. */
function readCwdFromCodexJsonl(path: string): string | undefined {
  const header = readTranscriptHeader(path);
  if (!header) return undefined;
  const firstNewline = header.text.indexOf('\n');
  const firstLine = firstNewline === -1 ? header.text : header.text.slice(0, firstNewline);
  try {
    const obj = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    const cwd = obj.payload?.cwd;
    return typeof cwd === 'string' ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opencode session JSON: top-level `directory` field. Opencode writes
 * the whole session as a single JSON object, so a truncated read can't
 * be parsed — the closing brace is missing. Re-read the full file when
 * `truncated` flips, since real opencode session records are typically
 * a few hundred bytes (summary, directory, ids) but we don't want to
 * silently miss a larger one.
 */
function readCwdFromOpencodeSession(path: string): string | undefined {
  const header = readTranscriptHeader(path);
  if (!header) return undefined;
  let body = header.text;
  if (header.truncated) {
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }
  try {
    const obj = JSON.parse(body) as { directory?: unknown };
    return typeof obj.directory === 'string' ? obj.directory : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the persona-improver in headless one-shot mode against the given
 * persona + transcript. Returns the parsed proposals file on success.
 *
 * Throws on: missing improver in catalog, harness binary not on PATH,
 * non-zero harness exit, or unparseable proposals JSON. Caller is expected
 * to surface the message and skip the apply step.
 */
async function runPersonaImprover(args: {
  personaFilePath: string;
  transcriptPath: string;
  proposalsOutputPath: string;
}): Promise<ImproverProposalsFile> {
  const improverSpec = personaCatalog['persona-improvement' as const];
  if (!improverSpec) {
    throw new Error('built-in persona "persona-improver" is not registered in the catalog');
  }
  const tier: PersonaTier = 'best-value';
  const selection = buildSelection(improverSpec, tier, 'repo');
  const inputValues: Record<string, string> = {
    PERSONA_FILE_PATH: args.personaFilePath,
    SESSION_TRANSCRIPT_PATH: args.transcriptPath,
    PROPOSALS_OUTPUT_PATH: args.proposalsOutputPath
  };
  const inputResolution = resolvePersonaInputs(
    selection.inputs,
    inputValues,
    process.env
  );
  const renderedSystemPrompt = renderPersonaInputs(
    selection.runtime.systemPrompt,
    inputResolution.values
  );
  const callerEnv = { ...process.env, ...inputResolution.values };
  const envResolution = resolveStringMapLenient(selection.env, callerEnv, 'env');
  const mcpResolution = resolveMcpServersLenient(selection.mcpServers, callerEnv);
  const taskBody = [
    'Improve this local persona from one finished session. The CLI will read your proposals JSON and walk the user through accept/deny.',
    `PERSONA_FILE_PATH=${args.personaFilePath}`,
    `SESSION_TRANSCRIPT_PATH=${args.transcriptPath}`,
    `PROPOSALS_OUTPUT_PATH=${args.proposalsOutputPath}`
  ].join('\n');
  const task = `${taskBody}\n\nRun inputs:\n${JSON.stringify(inputValues, null, 2)}`;
  const spec = buildNonInteractiveSpec({
    harness: selection.runtime.harness,
    personaId: selection.personaId,
    model: selection.runtime.model,
    systemPrompt: renderedSystemPrompt,
    harnessSettings: selection.runtime.harnessSettings,
    mcpServers: mcpResolution.servers,
    permissions: selection.permissions,
    task
  });
  const childEnv = { ...callerEnv, ...(envResolution.value ?? {}), ...inputResolution.values };
  const cwd = process.cwd();
  const configWrites: { path: string; existed: boolean; previous?: string }[] = [];
  for (const file of spec.configFiles) {
    assertSafeRelativePath(file.path);
    const target = join(cwd, file.path);
    const existed = existsSync(target);
    const previous = existed ? readFileSync(target, 'utf8') : undefined;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
    configWrites.push({ path: target, existed, ...(previous !== undefined ? { previous } : {}) });
  }
  const restoreConfigWrites = () => {
    for (const write of [...configWrites].reverse()) {
      if (write.existed) {
        writeFileSync(write.path, write.previous ?? '', 'utf8');
      } else {
        rmSync(write.path, { force: true });
      }
    }
  };
  const timeoutMs = selection.runtime.harnessSettings.timeoutSeconds
    ? selection.runtime.harnessSettings.timeoutSeconds * 1000
    : undefined;
  let captureResult: { exitCode: number | null; stderr: string };
  try {
    captureResult = await new Promise<{ exitCode: number | null; stderr: string }>(
      (resolveResult) => {
        const child = spawn(spec.bin, [...spec.args], {
          cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false
        });
        let stderrBuf = '';
        let forceKillTimeout: NodeJS.Timeout | undefined;
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderrBuf += chunk;
        });
        // SIGTERM first; if the harness traps or ignores it, escalate to
        // SIGKILL after a 1s grace so the timeout is actually enforced.
        const timeout =
          timeoutMs !== undefined
            ? setTimeout(() => {
                child.kill('SIGTERM');
                forceKillTimeout = setTimeout(() => {
                  if (!child.killed) child.kill('SIGKILL');
                }, 1000);
              }, timeoutMs)
            : undefined;
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (forceKillTimeout) clearTimeout(forceKillTimeout);
        };
        child.on('error', (err) => {
          clearTimers();
          resolveResult({ exitCode: 1, stderr: `${stderrBuf}${err.message}\n` });
        });
        child.on('close', (code, signal) => {
          clearTimers();
          const exitCode =
            typeof code === 'number' ? code : signal ? signalExitCode(signal) : null;
          resolveResult({ exitCode, stderr: stderrBuf });
        });
      }
    );
  } finally {
    // Always restore — a synchronous spawn() throw or unexpected promise
    // rejection must not leave orphaned `opencode.json` (or any other
    // configFile) sitting in the user's working directory.
    restoreConfigWrites();
  }
  if (captureResult.exitCode !== 0) {
    throw new Error(
      `improver exited with code=${captureResult.exitCode ?? 'null'}.${captureResult.stderr ? ` stderr: ${captureResult.stderr.slice(0, 400)}` : ''}`
    );
  }
  let raw: string;
  try {
    raw = readFileSync(args.proposalsOutputPath, 'utf8');
  } catch (err) {
    throw new Error(
      `improver did not write proposals file at ${args.proposalsOutputPath}: ${(err as Error).message}`
    );
  }
  return parseProposals(raw);
}

export function parseProposals(raw: string): ImproverProposalsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`proposals file is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('proposals file must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const proposalsArr = Array.isArray(obj.proposals) ? obj.proposals : [];
  const proposals: ImproverProposal[] = [];
  for (const [idx, item] of proposalsArr.entries()) {
    if (!item || typeof item !== 'object') {
      throw new Error(`proposals[${idx}] must be an object`);
    }
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id.trim()) {
      throw new Error(`proposals[${idx}].id must be a non-empty string`);
    }
    if (typeof p.summary !== 'string' || !p.summary.trim()) {
      throw new Error(`proposals[${idx}].summary must be a non-empty string`);
    }
    if (typeof p.rationale !== 'string') {
      throw new Error(`proposals[${idx}].rationale must be a string`);
    }
    if (!Array.isArray(p.patches) || p.patches.length === 0) {
      throw new Error(`proposals[${idx}].patches must be a non-empty array`);
    }
    const patches: ImproverPatch[] = [];
    for (const [pidx, rawPatch] of p.patches.entries()) {
      if (!rawPatch || typeof rawPatch !== 'object') {
        throw new Error(`proposals[${idx}].patches[${pidx}] must be an object`);
      }
      const rp = rawPatch as Record<string, unknown>;
      if (typeof rp.path !== 'string' || !rp.path.trim()) {
        throw new Error(`proposals[${idx}].patches[${pidx}].path must be a non-empty string`);
      }
      if (rp.op !== 'set' && rp.op !== 'append') {
        throw new Error(
          `proposals[${idx}].patches[${pidx}].op must be "set" or "append"`
        );
      }
      const patch: ImproverPatch = { path: rp.path, op: rp.op, value: rp.value };
      assertAllowedImproverPatch(patch, `proposals[${idx}].patches[${pidx}]`);
      patches.push(patch);
    }
    proposals.push({
      id: p.id,
      summary: p.summary,
      rationale: p.rationale,
      patches
    });
  }
  return {
    personaId: typeof obj.personaId === 'string' ? obj.personaId : '',
    personaFilePath: typeof obj.personaFilePath === 'string' ? obj.personaFilePath : '',
    transcriptPath: typeof obj.transcriptPath === 'string' ? obj.transcriptPath : '',
    proposals
  };
}

/**
 * Walk improver proposals one-by-one over the TTY. Returns only the
 * accepted proposals; the caller applies the patches. Supports:
 *   y / n — accept or skip the current proposal
 *   a     — accept this and all remaining proposals
 *   q     — quit without accepting any further proposals (already-accepted ones stay)
 *
 * On a non-TTY we shouldn't have reached this point (caller checks),
 * but if we do, return an empty list so nothing is auto-applied.
 */
function walkProposalsInteractive(file: ImproverProposalsFile): ImproverProposal[] {
  if (!process.stdin.isTTY) return [];
  const accepted: ImproverProposal[] = [];
  const total = file.proposals.length;
  let acceptAll = false;
  for (let i = 0; i < total; i++) {
    const proposal = file.proposals[i];
    process.stderr.write(`\n[${i + 1}/${total}] ${proposal.summary}\n`);
    if (proposal.rationale) {
      process.stderr.write(`  why: ${proposal.rationale}\n`);
    }
    for (const patch of proposal.patches) {
      const preview = formatPatchPreview(patch);
      process.stderr.write(`  ${preview}\n`);
    }
    if (acceptAll) {
      accepted.push(proposal);
      process.stderr.write('  → accepted (accept-all)\n');
      continue;
    }
    // 'n' is first so empty Enter defaults to skip (matches the
    // [y/N] default-no convention used by promptYesNoSync at the
    // session-end "auto-improve?" prompt). If the user hammers Enter
    // through a stack of proposals they get a no-op outcome, not an
    // unintended file mutation.
    const choice = readSingleCharChoice('  accept? [y/N/a/q] ', ['n', 'y', 'a', 'q']);
    if (choice === 'y') {
      accepted.push(proposal);
    } else if (choice === 'a') {
      accepted.push(proposal);
      acceptAll = true;
    } else if (choice === 'q') {
      process.stderr.write('  → quit; no further proposals will be reviewed.\n');
      break;
    }
    // 'n' (and bare Enter) falls through with no accept.
  }
  return accepted;
}

/**
 * Render a one-line patch preview. Truncates long string values so a
 * multi-paragraph systemPrompt rewrite doesn't dominate the screen.
 */
function formatPatchPreview(patch: ImproverPatch): string {
  const op = patch.op === 'append' ? '+= ' : '= ';
  const valueStr = formatPatchValue(patch.value);
  return `${patch.path} ${op}${valueStr}`;
}

function formatPatchValue(value: unknown): string {
  if (typeof value === 'string') {
    const condensed = value.replace(/\s+/g, ' ').trim();
    return condensed.length > 100 ? `"${condensed.slice(0, 97)}..."` : `"${condensed}"`;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '<undefined>';
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return '<unserializable>';
  }
}

/**
 * Read a single-character choice from stdin synchronously, looping on
 * invalid input. Empty Enter (no character) returns the first option in
 * `valid` — callers should put the safe / default-no answer first.
 *
 * Test seam: callers can inject `read` so the prompt is exercisable
 * without a real TTY (mirrors `promptYesNoSync`).
 */
export function readSingleCharChoice(
  prompt: string,
  valid: readonly string[],
  opts: {
    write?: (chunk: string) => void;
    read?: () => string | undefined;
  } = {}
): string {
  const write = opts.write ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  for (;;) {
    write(prompt);
    const line = opts.read ? opts.read() : readLineFromStdinSync();
    const trimmed = (line ?? '').trim().toLowerCase();
    if (trimmed.length === 0) return valid[0];
    const ch = trimmed[0];
    if (valid.includes(ch)) return ch;
    write(`  invalid choice; expected one of: ${valid.join(', ')}\n`);
  }
}

/**
 * Apply accepted patches to the persona JSON on disk. Reads, mutates the
 * parsed object, writes back with two-space indent + trailing newline
 * (matches existing /personas style). Throws on unwriteable file or
 * unsupported patch op/path resolution.
 */
export function applyAcceptedPatches(
  personaFilePath: string,
  accepted: readonly ImproverProposal[]
): void {
  const raw = readFileSync(personaFilePath, 'utf8');
  const json = JSON.parse(raw) as Record<string, unknown>;
  for (const proposal of accepted) {
    for (const patch of proposal.patches) {
      applyPatchInPlace(json, patch);
    }
  }
  writeFileSync(personaFilePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
}

function applyPatchInPlace(root: Record<string, unknown>, patch: ImproverPatch): void {
  // Re-run the allowlist + prototype-segment guard at apply time, not
  // just at parse time. Belt-and-braces: a patch list constructed by a
  // future caller that bypasses parseProposals can't smuggle a
  // disallowed path past this point either.
  assertAllowedImproverPatch(patch, `applyPatchInPlace`);
  const segments = patch.path.split('.').filter((s) => s.length > 0);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cursor[seg];
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      cursor[seg] = created;
      cursor = created;
      continue;
    }
    if (typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`patch path "${patch.path}": "${seg}" is not an object`);
    }
    cursor = next as Record<string, unknown>;
  }
  const finalSeg = segments[segments.length - 1];
  if (patch.op === 'append') {
    const existing = cursor[finalSeg];
    if (existing === undefined) {
      cursor[finalSeg] = [patch.value];
      return;
    }
    if (!Array.isArray(existing)) {
      throw new Error(`patch path "${patch.path}": cannot append to non-array`);
    }
    existing.push(patch.value);
    return;
  }
  // op === 'set'
  cursor[finalSeg] = patch.value;
}

/**
 * Enumerate personas for the interactive TUI. Source label mirrors the cascade
 * shown by `agentworkforce list` so the picker tells the user *where* a
 * persona is coming from (cwd, user, dir:n, library) without a separate
 * lookup.
 */
export function buildTuiCandidates(): TuiCandidate[] {
  const byId = new Map<string, TuiCandidate>();
  for (const spec of listBuiltInPersonas()) {
    byId.set(spec.id, { id: spec.id, description: spec.description, source: 'library' });
  }
  for (const [id, spec] of local.byId.entries()) {
    byId.set(id, {
      id,
      description: spec.description,
      source: local.sources.get(id) ?? 'library'
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Bare-invocation flow: open the interactive TUI, then hand the chosen
 * persona to {@link runAgentSelector}. Quitting the picker (Esc / Ctrl-C)
 * exits with conventional 130 so shell pipelines see SIGINT-style failure.
 *
 * runAgentSelector terminates the process via process.exit; this function
 * only returns when the picker is dismissed without a selection.
 */
async function runInteractivePicker(): Promise<never> {
  const candidates = buildTuiCandidates();
  if (candidates.length === 0) {
    process.stderr.write(
      'No personas available. Try `agentworkforce install <pack>` or run with --help.\n'
    );
    process.exit(1);
  }
  const selected = await runPersonaPickerTui({
    candidates,
    recentIds: loadRecents()
  });
  if (!selected) {
    process.exit(130);
  }
  await runAgentSelector(selected, {
    installInRepo: false,
    noLaunchMetadata: false,
    dryRun: false
  });
  // runAgentSelector has Promise<never> return type; this is unreachable.
  process.exit(0);
}

/**
 * Enumerate persona candidates for the picker. Local overrides win over the
 * built-in catalog when ids collide; the picker only needs the projection
 * fields ({@link PickCandidate}), not full specs.
 */
export function buildPickCandidates(): PickCandidate[] {
  const byId = new Map<string, PickCandidate>();
  for (const spec of listBuiltInPersonas()) {
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
    { installInRepo: false, noLaunchMetadata: false, dryRun: false },
    inputValues
  );
  // runAgentSelector terminates via process.exit; this satisfies TS's
  // reachable-end-point check for the `Promise<never>` return type.
  process.exit(0);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  if (subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (!subcommand) {
    if (process.stdin.isTTY && process.stderr.isTTY) {
      await runInteractivePicker();
      // runInteractivePicker either runAgentSelector → process.exit, or
      // exits itself on quit / no-match. Satisfy TS's unreachable check.
      process.exit(0);
    }
    process.stdout.write(USAGE);
    process.exit(1);
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
  dryRun: boolean;
}

export interface CreateFlags extends AgentFlags {
  saveInDirectory?: string;
  saveDefault: boolean;
}

export function parseAgentArgs(args: readonly string[]): {
  flags: AgentFlags;
  positional: string[];
} {
  const flags: AgentFlags = {
    installInRepo: false,
    noLaunchMetadata: false,
    dryRun: false
  };
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
    if (arg === '--dry-run') {
      flags.dryRun = true;
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
  const flags: CreateFlags = {
    installInRepo: false,
    noLaunchMetadata: false,
    dryRun: false,
    saveDefault: false
  };
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
    if (arg === '--save-in-directory') {
      const value = valueOf(i, arg).trim();
      if (!value) die('create: --save-in-directory requires a non-empty value.');
      flags.saveInDirectory = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--save-in-directory=')) {
      const value = arg.slice('--save-in-directory='.length).trim();
      if (!value) die('create: --save-in-directory requires a non-empty value.');
      flags.saveInDirectory = value;
      continue;
    }
    if (arg === '--save-default') {
      flags.saveDefault = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: agentworkforce create [--save-in-directory=<cwd|user|dir:n|library|path>] [--save-default] [--install-in-repo] [--no-launch-metadata]\n'
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

  const target = resolveCreateTarget(flags.saveInDirectory);
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
