import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { RunnerStepExecutor, WorkflowRunRow } from '@agent-relay/sdk/workflows';
import { frontendImplementer, codeReviewer, architecturePlanner, requirementsAnalyst, debuggerPersona, securityReviewer, technicalWriter, verifierPersona, testStrategist, tddGuard, flakeHunter, opencodeWorkflowSpecialist, npmProvenancePublisher, cloudSandboxInfra, sageSlackEgressMigrator, sageProactiveRewirer, cloudSlackProxyGuard, agentRelayE2eConductor, capabilityDiscoverer, posthogAgent } from './generated/personas.js';
import defaultRoutingProfileJson from '../routing-profiles/default.json' with { type: 'json' };

export const HARNESS_VALUES = ['opencode', 'codex', 'claude'] as const;
export const PERSONA_TIERS = ['best', 'best-value', 'minimum'] as const;
export const PERSONA_TAGS = [
  'planning',
  'implementation',
  'review',
  'testing',
  'debugging',
  'documentation',
  'release',
  'discovery',
  'analytics'
] as const;
export const PERSONA_INTENTS = [
  'implement-frontend',
  'review',
  'architecture-plan',
  'requirements-analysis',
  'debugging',
  'security-review',
  'documentation',
  'verification',
  'test-strategy',
  'tdd-enforcement',
  'flake-investigation',
  'opencode-workflow-correctness',
  'npm-provenance',
  'cloud-sandbox-infra',
  'sage-slack-egress-migration',
  'sage-proactive-rewire',
  'cloud-slack-proxy-guard',
  'sage-cloud-e2e-conduction',
  'capability-discovery',
  'posthog'
] as const;

export type Harness = (typeof HARNESS_VALUES)[number];
export type PersonaTier = (typeof PERSONA_TIERS)[number];
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];
export type PersonaTag = (typeof PERSONA_TAGS)[number];

export interface HarnessSettings {
  reasoning: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
}

export interface PersonaRuntime {
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
}

/**
 * A skill is a named, reusable capability attached to a persona.
 * `source` points to canonical guidance the persona should apply
 * (e.g. a prpm.dev package URL, an internal runbook, a docs page).
 */
export interface PersonaSkill {
  id: string;
  source: string;
  description: string;
}

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan'
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Persona-level permission policy for the harness session. Translates to the
 * harness's native allow/deny/mode flags at spawn time. Tool-pattern syntax is
 * passed through verbatim — `"mcp__posthog"` to allow every posthog MCP tool,
 * `"mcp__posthog__projects-get"` for a specific one, `"Bash(git *)"` for a
 * shell pattern. See the target harness's docs for the exact grammar.
 */
export interface PersonaPermissions {
  /** Tool names/patterns to auto-approve. */
  allow?: string[];
  /** Tool names/patterns to always block. */
  deny?: string[];
  /** Permission mode for the session. */
  mode?: PermissionMode;
}

/**
 * MCP server config, structured to match Claude Code's `--mcp-config` JSON
 * verbatim so the whole object can be passed through untouched. Values inside
 * `headers` / `env` / `args` / `url` / `command` may be literal strings or
 * `$VAR` / `${VAR}` references. Resolution happens in the runner/CLI at spawn
 * time — this package only defines the shape, not the interpolation policy.
 */
export type McpServerSpec =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export interface PersonaSpec {
  id: string;
  intent: PersonaIntent;
  /**
   * Free-form classification labels (from {@link PERSONA_TAGS}). Every persona
   * has at least one; a persona may carry multiple tags when it spans concerns
   * (e.g. `['testing', 'implementation']`).
   */
  tags: PersonaTag[];
  description: string;
  skills: PersonaSkill[];
  tiers: Record<PersonaTier, PersonaRuntime>;
  /**
   * Environment variables injected into the harness child process.
   * Values may be literal strings or `$VAR` references resolved from the
   * caller's environment at spawn time.
   */
  env?: Record<string, string>;
  /**
   * MCP servers to attach to the harness session. Only wired for `claude`
   * today (via `--mcp-config`); other harnesses warn and skip.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Permission policy (allow/deny lists, mode) for the harness session.
   * Only wired for `claude` today (via `--allowedTools`, `--disallowedTools`,
   * `--permission-mode`); other harnesses warn and skip.
   */
  permissions?: PersonaPermissions;
}

export interface RoutingProfileRule {
  tier: PersonaTier;
  rationale: string;
}

export interface RoutingProfile {
  id: string;
  description: string;
  intents: Record<PersonaIntent, RoutingProfileRule>;
}

export interface PersonaSelection {
  personaId: string;
  tier: PersonaTier;
  runtime: PersonaRuntime;
  skills: PersonaSkill[];
  rationale: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
}

// ---------------------------------------------------------------------------
// Skill materialization
// ---------------------------------------------------------------------------
//
// Personas declare *what* skill they need via `skills: [{ id, source, ... }]`.
// The SDK is the only layer that knows *how* to make that skill available to
// a given harness — because each harness has its own on-disk convention and
// its own prpm install flag. Keeping this mapping here means:
//
//   1. Workflow authors never hand-type `prpm install ... --as codex`.
//   2. Changing install rules is a one-line SDK edit, not a repo-wide grep.
//   3. Persona JSON stays harness-agnostic and forward-compatible.
//
// `materializeSkills` is a pure function: it returns the install plan but
// never touches the filesystem or spawns processes. Callers (relay workflows,
// the OpenClaw spawner, ad-hoc scripts) decide how to execute it.

export const SKILL_SOURCE_KINDS = ['prpm', 'skill.sh'] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

/** Per-harness rules for where skills land on disk and how to ask prpm for them. */
export interface HarnessSkillTarget {
  /** Value passed to `prpm install --as <flag>`. */
  asFlag: string;
  /** Directory (relative to repo root) where prpm drops the skill package. */
  dir: string;
}

export const HARNESS_SKILL_TARGETS: Record<Harness, HarnessSkillTarget> = {
  claude: { asFlag: 'claude', dir: '.claude/skills' },
  codex: { asFlag: 'codex', dir: '.agents/skills' },
  opencode: { asFlag: 'opencode', dir: '.skills' }
};

/**
 * Options for {@link materializeSkills} / {@link materializeSkillsFor}.
 *
 * `installRoot` stages skills under an out-of-repo directory (typically
 * `~/.agent-workforce/sessions/<id>/claude/plugin`) that doubles as a Claude
 * Code plugin root. The SDK generates the scaffold (`.claude-plugin/plugin.json`
 * and a `skills` symlink pointing at `.claude/skills/`), prpm installs into
 * `<installRoot>/.claude/skills/<name>/`, and post-run cleanup removes the
 * entire `installRoot` in one `rm -rf` — no files ever touch the repo.
 *
 * Only honored for `harness === 'claude'`. Passing `installRoot` with another
 * harness throws. The absolute path is the caller's responsibility; the SDK
 * does not create parent directories on its own.
 */
export interface SkillMaterializationOptions {
  installRoot?: string;
}

export interface SkillInstall {
  skillId: string;
  /** Original `source` string from the persona JSON. */
  source: string;
  sourceKind: SkillSourceKind;
  /** Normalized package reference (e.g. `@prpm/npm-trusted-publishing`, `vercel-labs/skills#find-skills`). */
  packageRef: string;
  harness: Harness;
  /** argv-style command — safer than a shell string for execFile/spawn callers. */
  installCommand: readonly string[];
  /** Directory the skill is expected to land in after install. */
  installedDir: string;
  /** Path to the installed SKILL.md manifest (for prompt injection fallback). */
  installedManifest: string;
  /**
   * Paths the installer scatters outside of a durable lockfile — safe to
   * `rm -rf` once the persona run has read what it needs from them. The
   * provider's lockfile (`prpm.lock`, `skills-lock.json`, etc.) is deliberately
   * omitted so repeat runs can stay fast and reproducible.
   */
  cleanupPaths: readonly string[];
}

export interface SkillMaterializationPlan {
  harness: Harness;
  installs: SkillInstall[];
  /**
   * Absolute path to the out-of-repo stage directory, when the plan was
   * produced with {@link SkillMaterializationOptions.installRoot}. When set,
   * the install artifacts emit plugin scaffolding at this root and cleanup
   * removes the whole directory instead of individual skill paths.
   */
  sessionInstallRoot?: string;
}

export interface PersonaInstallContext {
  /** Pure install plan for the persona's skills. Describes what would be installed and where, with no side effects. */
  readonly plan: SkillMaterializationPlan;
  /** Full install command in argv form, suitable for `execFile`/`spawn` without shell escaping concerns. */
  readonly command: readonly string[];
  /** Shell-escaped form of the full install command, convenient for `spawn(..., { shell: true })`. */
  readonly commandString: string;
  /**
   * Post-run cleanup command (argv form) that removes the ephemeral artifact
   * paths the provider scatters during install, leaving the provider lockfile
   * in place. Callers running the install themselves (Mode B) should run this
   * **after** the agent step consumes the skills, never before. For empty
   * plans this is a shell no-op (`:`). `sendMessage()` wires this into a
   * post-agent workflow step automatically in Mode A.
   */
  readonly cleanupCommand: readonly string[];
  /** Shell-escaped form of {@link cleanupCommand}. */
  readonly cleanupCommandString: string;
}

/**
 * Options for {@link PersonaContext.sendMessage}. All fields are optional —
 * calling `sendMessage(task)` with no options is the common case.
 *
 * Pass `installSkills: false` when you have already pre-staged the persona's
 * skills via `usePersona(...).install.commandString` (e.g. in a Dockerfile or
 * a CI bootstrap step) and do not want `sendMessage()` to re-install them.
 * Leaving `installSkills` unset means `sendMessage()` installs skills itself as
 * the first step of the ad-hoc workflow — this is the default.
 */
export interface ExecuteOptions {
  /** Absolute or repo-relative path the spawned agent should treat as its CWD. */
  workingDirectory?: string;
  /** Optional step name override for the ad-hoc workflow run. */
  name?: string;
  /** Hard timeout for the install + agent run in seconds. */
  timeoutSeconds?: number;
  /** Optional structured context appended to the task body as JSON. */
  inputs?: Record<string, string | number | boolean>;
  /** Install persona skills before execution. Defaults to true. */
  installSkills?: boolean;
  /** Additional environment variables available to install + agent processes. */
  env?: NodeJS.ProcessEnv;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming stdout/stderr callback from install + agent subprocesses. */
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

/**
 * Final result of a {@link PersonaContext.sendMessage} call.
 *
 * **Only `status: 'completed'` is returned as a resolved promise.** Any
 * other outcome is delivered as a thrown error with a typed `.result`
 * property carrying this interface, so callers can `try/catch` and then
 * inspect `err.result.status`, `err.result.stderr`, `err.result.exitCode`
 * etc. just as they would read the resolved value:
 *
 * - `status: 'failed'` — the agent subprocess exited non-zero, or the
 *   workflow settled in a failed state for any other reason. Thrown as
 *   a {@link PersonaExecutionError}.
 * - `status: 'timeout'` — the workflow's hard timeout fired before the
 *   run completed. Also thrown as a {@link PersonaExecutionError} (the
 *   status is derived from the underlying timeout error).
 * - `status: 'cancelled'` — the caller aborted via
 *   {@link ExecuteOptions.signal} or {@link PersonaExecution.cancel}.
 *   Thrown as an `AbortError` (with `error.result.status === 'cancelled'`).
 *
 * So the typical shape of a caller is:
 *
 * ```ts
 * try {
 *   const result = await sendMessage(task, opts);
 *   // result.status is guaranteed to be 'completed' here.
 * } catch (err) {
 *   // err.result.status is 'failed' | 'cancelled' | 'timeout'.
 *   // err.result.stderr / err.result.exitCode are populated from
 *   // whatever the agent subprocess produced.
 * }
 * ```
 */
export interface ExecuteResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  output: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  workflowRunId?: string;
  stepName: string;
}

/**
 * Handle returned by {@link PersonaContext.sendMessage}. It *is* a `Promise<ExecuteResult>`
 * (awaitable directly), with two extra members bolted on:
 *
 * - `cancel(reason?)` — request cancellation of the running workflow. Equivalent
 *   to aborting the `AbortSignal` passed via {@link ExecuteOptions.signal}. Safe
 *   to call after the run has already settled (no-op).
 *
 * - `runId` — a `Promise<string>` that resolves to the workflow run id
 *   once the persona's agent step has actually spawned. This is deliberately
 *   a promise (not `string | undefined`) because the id is not known at the
 *   moment `sendMessage()` returns — the workflow hasn't started yet. The
 *   resolution timing contract is:
 *
 *     1. If the agent subprocess emits any stdout/stderr, `runId` resolves
 *        immediately on the first progress event (see `onStepProgress`).
 *     2. Otherwise, it resolves ~250ms after the agent step spawns (safety
 *        net armed in `onStepSpawn`, see `src/index.ts` around the
 *        `runIdReadyTimer` definition).
 *     3. If the run settles (completes/fails/cancels) before either of the
 *        above fire, it resolves at settle time with the final run id.
 *
 *   Practical consequence: `await run.runId` is *not* instantaneous — do not
 *   block on it in a tight synchronous path expecting a cached value.
 *
 *   Error mirroring: if `sendMessage()` fails before the workflow has started
 *   (e.g. the dynamic `@agent-relay/sdk/workflows` import throws, or the
 *   `WorkflowRunner` constructor throws), `runId` rejects with the same
 *   error as the main promise. Awaiting `runId` is therefore safe to
 *   `try/catch` — you will observe the same failure twice, not miss it.
 *   Note that you are not required to observe `runId`; the main promise
 *   is the authoritative outcome channel, and the auxiliary rejection
 *   on `runId` is internally suppressed when no handler is attached.
 */
export interface PersonaExecution extends Promise<ExecuteResult> {
  cancel(reason?: string): void;
  readonly runId: Promise<string>;
}

/**
 * Return value of {@link usePersona}. A side-effect-free bundle of
 * "what this persona is" plus grouped install metadata and a
 * `sendMessage()` closure for running it.
 *
 * There are two ways to use the fields, and they are **alternatives**,
 * not sequential steps:
 *
 * **Mode A — let `sendMessage()` handle install (recommended default):**
 * ```ts
 * const { sendMessage } = usePersona('npm-provenance');
 * const result = await sendMessage('Your task', { workingDirectory: '.' });
 * ```
 * `sendMessage()` installs the persona's skills as the first step of its
 * ad-hoc workflow, then runs the agent task. No manual install needed.
 *
 * **Mode B — pre-stage install yourself, then `sendMessage()` without re-install:**
 * ```ts
 * const { install, sendMessage } = usePersona('npm-provenance');
 * // e.g. inside a Dockerfile RUN, or a CI bootstrap step:
 * spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
 * // then, at runtime:
 * const result = await sendMessage('Your task', {
 *   workingDirectory: '.',
 *   installSkills: false, // skip re-install; skills are already staged
 * });
 * ```
 * Use this when you want to install skills once at build/CI time for
 * caching, hermeticity, offline runtime, or split-trust reasons — or
 * when you want to wrap the install with your own process management
 * (custom timeout, logging, retry, alternative runner, etc.).
 *
 * In both modes, the `await sendMessage(...)` call above **only resolves
 * when `status === 'completed'`**. Non-zero exits / timeouts throw a
 * {@link PersonaExecutionError}, and cancellation throws an `AbortError`;
 * both carry a typed `.result` for inspection. See {@link ExecuteResult}
 * for the full outcome contract.
 *
 * ⚠️ **Do not combine the two modes without `installSkills: false`.**
 * Running `spawnSync(install.commandString, ...)` *and then* calling
 * `sendMessage(task)` without passing `installSkills: false` will install
 * the persona's skills twice. The default value of `installSkills` is
 * `true` (see {@link ExecuteOptions}).
 *
 * A third usage is install-only: if all you want is to materialize
 * the persona's skills into the repo (for a human or another tool
 * to use), run `install.commandString` and never call `sendMessage()`.
 */
export interface PersonaContext {
  /** Resolved persona choice for this intent/profile: identity, tier, runtime, skills, and routing rationale. */
  readonly selection: PersonaSelection;
  /** Grouped install metadata for the resolved persona's skills. */
  readonly install: PersonaInstallContext;
  /**
   * Run the resolved persona against `task`. Builds an ad-hoc agent-relay
   * workflow, optionally runs `prpm install` as its first step (see
   * {@link ExecuteOptions.installSkills}, default `true`), then invokes the
   * persona's harness agent with the task. Returns a {@link PersonaExecution}
   * (an awaitable promise with `cancel()` and `runId` attached).
   */
  sendMessage(task: string, options?: ExecuteOptions): PersonaExecution;
}

export class PersonaExecutionError extends Error {
  readonly result: ExecuteResult;
  override cause?: unknown;

  constructor(message: string, result: ExecuteResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PersonaExecutionError';
    this.result = result;
    this.cause = cause;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

interface CommandCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

class CapturedCommandError extends Error {
  readonly capture: CommandCapture;

  constructor(message: string, capture: CommandCapture) {
    super(message);
    this.name = 'CapturedCommandError';
    this.capture = capture;
  }
}

// ---------------------------------------------------------------------------
// Skill providers
// ---------------------------------------------------------------------------
//
// Each provider (prpm, skill.sh, ...) owns three concerns:
//   1. How to parse its source-string shape out of a persona JSON entry.
//   2. How to build the concrete `npx ...` install command for a given harness.
//   3. Which ephemeral paths the installer writes that should be cleaned up
//      after the persona run finishes. The provider's *lockfile* is NOT in
//      that list — it stays on disk so repeat runs reuse resolved versions.
//
// Adding a new skill source kind = add one provider entry here; everything
// else (materializeSkills, buildInstallArtifacts, tests) picks it up via the
// common interface.

interface ResolvedSkillSource {
  kind: SkillSourceKind;
  packageRef: string;
  /** Directory name used for the installed skill (e.g. `npm-trusted-publishing`). */
  installedName: string;
}

interface SkillProvider {
  readonly kind: SkillSourceKind;
  /** Parse a persona `source` string; return null if this provider does not claim it. */
  parse(source: string): ResolvedSkillSource | null;
  /** Build the argv-style install command for `materializeSkills`. */
  buildInstallCommand(ref: ResolvedSkillSource, harness: Harness): readonly string[];
  /**
   * Ephemeral paths the installer scatters for this skill under `harness` that are
   * safe to remove once the persona has finished reading them. Does not include
   * the provider's lockfile.
   */
  cleanupPaths(ref: ResolvedSkillSource, harness: Harness): readonly string[];
}

const PRPM_URL_RE =
  /^https?:\/\/prpm\.dev\/packages\/([^/\s?#]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/i;
const PRPM_BARE_REF_RE = /^([^/\s]+)\/([^/\s]+)$/;

function lastSegment(ref: string): string {
  const slash = ref.lastIndexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

const prpmProvider: SkillProvider = {
  kind: 'prpm',
  parse(source) {
    const urlMatch = source.match(PRPM_URL_RE);
    if (urlMatch) {
      const ref = `${urlMatch[1]}/${urlMatch[2]}`;
      return { kind: 'prpm', packageRef: ref, installedName: lastSegment(ref) };
    }
    const bareMatch = source.match(PRPM_BARE_REF_RE);
    if (bareMatch) {
      return { kind: 'prpm', packageRef: source, installedName: lastSegment(source) };
    }
    return null;
  },
  buildInstallCommand(ref, harness) {
    const target = HARNESS_SKILL_TARGETS[harness];
    return Object.freeze([
      'npx',
      '-y',
      'prpm',
      'install',
      ref.packageRef,
      '--as',
      target.asFlag
    ]) as readonly string[];
  },
  cleanupPaths(ref, harness) {
    const target = HARNESS_SKILL_TARGETS[harness];
    return Object.freeze([`${target.dir}/${ref.installedName}`]) as readonly string[];
  }
};

// skill.sh source form: `<github-url>#<skill-name>`
// Example: `https://github.com/vercel-labs/skills#find-skills`
const SKILL_SH_URL_RE =
  /^(https?:\/\/github\.com\/[^/\s?#]+\/[^/\s?#]+?)(?:\.git)?#([^\s?#]+)$/i;

/**
 * Paths `npx skills add` writes per install. Mirrors the on-disk layout from
 * a live `npx -y skills add ... -y` run (universal dir + harness-side
 * symlinks). `skills-lock.json` is deliberately excluded so repeat runs can
 * re-resolve from the lock instead of refetching sources.
 */
function skillShArtifactPaths(installedName: string): readonly string[] {
  return Object.freeze([
    `.agents/skills/${installedName}`,
    `.claude/skills/${installedName}`,
    `.factory/skills/${installedName}`,
    `.kiro/skills/${installedName}`,
    `skills/${installedName}`
  ]) as readonly string[];
}

const skillShProvider: SkillProvider = {
  kind: 'skill.sh',
  parse(source) {
    const match = source.match(SKILL_SH_URL_RE);
    if (!match) {
      return null;
    }
    const [, repoUrl, skillName] = match;
    return {
      kind: 'skill.sh',
      // packageRef preserves the full `<repo>#<skill>` shape so the command builder
      // can reconstruct both halves without re-parsing the original source.
      packageRef: `${repoUrl}#${skillName}`,
      installedName: skillName
    };
  },
  buildInstallCommand(ref) {
    const [repoUrl, skillName] = ref.packageRef.split('#');
    return Object.freeze([
      'npx',
      '-y',
      'skills',
      'add',
      repoUrl,
      '--skill',
      skillName,
      '-y'
    ]) as readonly string[];
  },
  cleanupPaths(ref) {
    // skill.sh installs the same universal dir + harness symlinks regardless
    // of which agent is the "host" — clean all of them so nothing leaks into
    // `.claude/`, `.agents/`, etc. after the persona run.
    return skillShArtifactPaths(ref.installedName);
  }
};

const SKILL_PROVIDERS: readonly SkillProvider[] = Object.freeze([prpmProvider, skillShProvider]);

function resolveSkillSource(source: string): ResolvedSkillSource {
  for (const provider of SKILL_PROVIDERS) {
    const parsed = provider.parse(source);
    if (parsed) {
      return parsed;
    }
  }
  throw new Error(
    `Unsupported skill source: ${source}. ` +
      `Supported forms: prpm.dev package URL (https://prpm.dev/packages/<scope>/<name>), ` +
      `bare "<scope>/<name>" prpm reference, ` +
      `or skill.sh github URL with skill fragment (https://github.com/<org>/<repo>#<skill>).`
  );
}

function providerFor(kind: SkillSourceKind): SkillProvider {
  const provider = SKILL_PROVIDERS.find((p) => p.kind === kind);
  if (!provider) {
    throw new Error(`No skill provider registered for kind: ${kind}`);
  }
  return provider;
}

/**
 * Given a set of persona skills and the harness the persona will run under,
 * produce the concrete install plan: which install invocations to run, where
 * the skill will land on disk, and which artifact paths should be cleaned up
 * after the persona run to keep the workspace tidy.
 *
 * Pure function — does not execute commands or touch the filesystem.
 */
export function materializeSkills(
  skills: readonly PersonaSkill[],
  harness: Harness,
  options: SkillMaterializationOptions = {}
): SkillMaterializationPlan {
  const target = HARNESS_SKILL_TARGETS[harness];
  if (!target) {
    throw new Error(`No skill install target configured for harness: ${harness}`);
  }
  const { installRoot } = options;
  if (installRoot !== undefined && harness !== 'claude') {
    throw new Error(
      `installRoot is only supported for the claude harness (got: ${harness}). ` +
        `codex and opencode still install into the harness's conventional repo-relative directory.`
    );
  }

  const installs = skills.map((skill): SkillInstall => {
    const resolved = resolveSkillSource(skill.source);
    const provider = providerFor(resolved.kind);
    const baseCommand = provider.buildInstallCommand(resolved, harness);
    // In session-install-root mode, the install runs `cd <installRoot> && <prpm>`
    // so that prpm's harness-relative dirs (`.claude/skills/<name>`) land
    // inside the stage dir instead of the user's repo. The per-install command
    // stays self-contained so callers who run a single install.installCommand
    // directly still get the correct placement.
    const installCommand =
      installRoot !== undefined
        ? (Object.freeze([
            'sh',
            '-c',
            `cd ${shellEscape(installRoot)} && ${commandToShellString(baseCommand)}`
          ]) as readonly string[])
        : baseCommand;
    // For prompt-injection fallback we still want a single canonical manifest
    // path. prpm installs into the harness target dir; skill.sh installs into
    // its universal `.agents/skills` dir regardless of harness, so key off
    // whichever cleanup path ends in the installed name.
    const repoRelativeDir =
      resolved.kind === 'skill.sh'
        ? `.agents/skills/${resolved.installedName}`
        : `${target.dir}/${resolved.installedName}`;
    const installedDir =
      installRoot !== undefined ? `${installRoot}/${repoRelativeDir}` : repoRelativeDir;
    // When the plan stages into `installRoot`, cleanup targets the whole
    // session dir (handled at plan level in buildCleanupArtifacts). Leave
    // per-skill cleanupPaths empty so Mode B callers running individual
    // install.cleanupPaths don't accidentally remove unrelated things.
    const cleanupPaths =
      installRoot !== undefined
        ? (Object.freeze([]) as readonly string[])
        : provider.cleanupPaths(resolved, harness);
    return {
      skillId: skill.id,
      source: skill.source,
      sourceKind: resolved.kind,
      packageRef: resolved.packageRef,
      harness,
      installCommand,
      installedDir,
      installedManifest: `${installedDir}/SKILL.md`,
      cleanupPaths
    };
  });

  return {
    harness,
    installs,
    ...(installRoot !== undefined ? { sessionInstallRoot: installRoot } : {})
  };
}

/**
 * Convenience wrapper: derive the install plan directly from a resolved
 * persona selection, using its tier's harness automatically.
 */
export function materializeSkillsFor(
  selection: PersonaSelection,
  options: SkillMaterializationOptions = {}
): SkillMaterializationPlan {
  return materializeSkills(selection.skills, selection.runtime.harness, options);
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShellString(command: readonly string[]): string {
  return command.map(shellEscape).join(' ');
}

/**
 * Minimal Claude Code plugin manifest written to `<root>/.claude-plugin/plugin.json`
 * in session-install-root mode. Claude's plugin loader treats any directory
 * that contains this file (alongside a `skills/` tree) as a plugin; we pass
 * the root to `claude --plugin-dir <root>` so the session sees exactly the
 * skills we staged — and nothing the repo happens to carry.
 */
const SESSION_PLUGIN_MANIFEST = JSON.stringify({
  name: 'agent-workforce-session',
  version: '0.0.0',
  description: 'Ephemeral skills staged by agent-workforce for this session.'
});

function buildSessionScaffoldCommand(root: string): string {
  const q = shellEscape(root);
  // mkdir -p creates both the plugin metadata dir and the prpm target.
  // `ln -sfn .claude/skills skills` makes Claude's expected plugin layout
  // (`<root>/skills/<name>/SKILL.md`) resolve to prpm's actual output
  // (`<root>/.claude/skills/<name>/SKILL.md`) without moving any files.
  // The -n guards against following into an existing `skills/` dir (e.g.
  // when the session dir is reused), and -f replaces a prior symlink so
  // the scaffold is idempotent.
  return [
    `mkdir -p ${q}/.claude-plugin ${q}/.claude/skills`,
    `ln -sfn .claude/skills ${q}/skills`,
    `printf '%s' ${shellEscape(SESSION_PLUGIN_MANIFEST)} > ${q}/.claude-plugin/plugin.json`
  ].join(' && ');
}

function buildInstallArtifacts(plan: SkillMaterializationPlan): {
  installCommand: readonly string[];
  installCommandString: string;
} {
  if (plan.sessionInstallRoot !== undefined) {
    // Session mode always stages a plugin dir so the caller can pass
    // `--plugin-dir <root>` to claude unconditionally. Even for personas
    // with zero skills, we emit the scaffold (mkdir + manifest + symlink)
    // so the `--plugin-dir` target exists.
    const root = plan.sessionInstallRoot;
    const scaffold = buildSessionScaffoldCommand(root);
    if (plan.installs.length === 0) {
      return {
        installCommand: Object.freeze(['sh', '-c', scaffold]) as readonly string[],
        installCommandString: scaffold
      };
    }
    // Chain the raw provider commands after a single `cd <root>` so we emit
    // one shell invocation instead of repeating the cd per skill. Each
    // install.installCommand is already self-contained (`sh -c 'cd <root> &&
    // …'`) for callers who want to run one at a time, but here we flatten
    // to the underlying prpm argv for a cleaner chain.
    const perSkill = plan.installs
      .map((install) => {
        const resolved = resolveSkillSource(install.source);
        const provider = providerFor(resolved.kind);
        return commandToShellString(provider.buildInstallCommand(resolved, plan.harness));
      })
      .join(' && ');
    const installCommandString = `${scaffold} && cd ${shellEscape(root)} && ${perSkill}`;
    return {
      installCommand: Object.freeze(['sh', '-c', installCommandString]) as readonly string[],
      installCommandString
    };
  }

  if (plan.installs.length === 0) {
    return {
      installCommand: Object.freeze(['sh', '-c', ':']) as readonly string[],
      installCommandString: ':'
    };
  }

  const installCommandString = plan.installs
    .map((install) => commandToShellString(install.installCommand))
    .join(' && ');
  return {
    installCommand: Object.freeze(['sh', '-c', installCommandString]) as readonly string[],
    installCommandString
  };
}

/**
 * Post-run cleanup: one shell command that removes every ephemeral artifact
 * path declared across all installs in the plan. Runs AFTER the agent step so
 * the agent can still read skill manifests off disk during execution. The
 * provider lockfile is deliberately not in the path set, so repeat runs keep
 * cached resolution.
 *
 * Empty plans return `:` (shell no-op) to keep the post-step shape uniform.
 */
function buildCleanupArtifacts(plan: SkillMaterializationPlan): {
  cleanupCommand: readonly string[];
  cleanupCommandString: string;
} {
  // Session mode: cleanup is the whole stage dir. The scaffold always runs
  // (even for zero-skill personas), so cleanup unconditionally drops the
  // stage dir. The CLI is responsible for removing the enclosing session
  // root; this command covers the install subtree.
  if (plan.sessionInstallRoot !== undefined) {
    const cleanupCommandString = `rm -rf ${shellEscape(plan.sessionInstallRoot)}`;
    return {
      cleanupCommand: Object.freeze(['sh', '-c', cleanupCommandString]) as readonly string[],
      cleanupCommandString
    };
  }
  const allPaths = plan.installs.flatMap((install) => [...install.cleanupPaths]);
  const cleanupCommandString =
    allPaths.length === 0 ? ':' : `rm -rf ${allPaths.map(shellEscape).join(' ')}`;
  return {
    cleanupCommand: Object.freeze(['sh', '-c', cleanupCommandString]) as readonly string[],
    cleanupCommandString
  };
}

function buildExecutionTask(
  systemPrompt: string,
  task: string,
  inputs?: Record<string, string | number | boolean>
): string {
  const sections = [`System Instructions:\n${systemPrompt.trim()}`, `Task:\n${task.trim()}`];
  if (inputs && Object.keys(inputs).length > 0) {
    sections.push(`Additional Inputs (JSON):\n${JSON.stringify(inputs, null, 2)}`);
  }
  return sections.join('\n\n');
}

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function sanitizeExecutionName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || `persona-${hash8(value)}`;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: Deferred<T>['resolve'];
  let rejectFn!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value) => {
      settled = true;
      resolve(value);
    };
    rejectFn = (reason) => {
      settled = true;
      reject(reason);
    };
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    get settled() {
      return settled;
    }
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isTimeoutError(message: string | undefined): boolean {
  return typeof message === 'string' && /timed out/i.test(message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value) as T;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value) as T;
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function runCapturedCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSpawn?: () => void;
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}): Promise<CommandCapture> {
  const { command, args, cwd, env, timeoutMs, signal, onSpawn, onProgress } = options;
  return new Promise<CommandCapture>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('Execution aborted before the process started'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let killId: NodeJS.Timeout | undefined;
    let abortDelayId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killId) {
        clearTimeout(killId);
      }
      if (abortDelayId) {
        clearTimeout(abortDelayId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    const terminate = () => {
      child.kill('SIGTERM');
      killId = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killId.unref?.();
    };

    const abortHandler = () => {
      if (stdout.length === 0 && stderr.length === 0) {
        abortDelayId = setTimeout(() => {
          abortDelayId = undefined;
          terminate();
        }, 15);
        abortDelayId.unref?.();
        return;
      }

      terminate();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killId = setTimeout(() => child.kill('SIGKILL'), 5_000);
        killId.unref?.();
      }, timeoutMs);
      timeoutId.unref?.();
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onProgress?.({ stream: 'stdout', text });
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stream: 'stderr', text });
    });

    onSpawn?.();

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (code, exitSignal) => {
      cleanup();
      const capture: CommandCapture = {
        stdout,
        stderr,
        exitCode: code,
        exitSignal: (exitSignal as NodeJS.Signals | null) ?? null
      };

      if (signal?.aborted) {
        const error = createAbortError('Execution cancelled');
        Object.assign(error, { capture });
        reject(error);
        return;
      }

      if (timedOut) {
        reject(
          new CapturedCommandError(
            `Command timed out after ${timeoutMs ?? 'unknown'}ms`,
            capture
          )
        );
        return;
      }

      resolve(capture);
    });
  });
}

function createLocalExecutor(
  stepCaptures: Map<string, CommandCapture>,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStepSpawn?: (stepName: string) => void;
    onStepProgress?: (
      stepName: string,
      chunk: { stream: 'stdout' | 'stderr'; text: string }
    ) => void;
    onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  },
  buildCommand: (cli: Harness, extraArgs: string[] | undefined, task: string) => string[]
): RunnerStepExecutor {
  const execute = async (
    stepName: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
    ignoreExitCode = false
  ): Promise<CommandCapture> => {
    const partialCapture: CommandCapture = {
      stdout: '',
      stderr: '',
      exitCode: null,
      exitSignal: null
    };

    try {
      const capture = await runCapturedCommand({
        command,
        args,
        cwd,
        env: options.env,
        timeoutMs,
        signal: options.signal,
        onSpawn: () => {
          stepCaptures.set(stepName, { ...partialCapture });
          options.onStepSpawn?.(stepName);
        },
        onProgress: (chunk) => {
          if (chunk.stream === 'stdout') {
            partialCapture.stdout += chunk.text;
          } else {
            partialCapture.stderr += chunk.text;
          }
          stepCaptures.set(stepName, { ...partialCapture });
          options.onStepProgress?.(stepName, chunk);
          options.onProgress?.(chunk);
        }
      });
      stepCaptures.set(stepName, capture);
      if (!ignoreExitCode && capture.exitCode !== null && capture.exitCode !== 0) {
        throw new CapturedCommandError(
          `Step "${stepName}" exited with code ${capture.exitCode}`,
          capture
        );
      }
      return capture;
    } catch (error) {
      const capture = error instanceof CapturedCommandError ? error.capture : (error as { capture?: CommandCapture }).capture;
      if (capture) {
        stepCaptures.set(stepName, capture);
      }
      throw error;
    }
  };

  return {
    async executeAgentStep(step, agentDef, resolvedTask, timeoutMs) {
      const extraArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : undefined;
      const [command, ...args] = buildCommand(agentDef.cli as Harness, extraArgs, resolvedTask);
      const capture = await execute(
        step.name,
        command,
        args,
        resolvePath(step.cwd ?? options.cwd),
        timeoutMs,
        agentDef.cli === 'opencode'
      );
      return capture.stdout;
    },
    async executeDeterministicStep(step, resolvedCommand, cwd) {
      const capture = await execute(
        step.name,
        'sh',
        ['-c', resolvedCommand],
        resolvePath(cwd),
        step.timeoutMs
      );
      return {
        output: capture.stdout,
        exitCode: capture.exitCode ?? 0
      };
    }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_VALUES.includes(value as Harness);
}

function isTier(value: unknown): value is PersonaTier {
  return typeof value === 'string' && PERSONA_TIERS.includes(value as PersonaTier);
}

function isIntent(value: unknown): value is PersonaIntent {
  return typeof value === 'string' && PERSONA_INTENTS.includes(value as PersonaIntent);
}

function isTag(value: unknown): value is PersonaTag {
  return typeof value === 'string' && PERSONA_TAGS.includes(value as PersonaTag);
}

function parseTags(value: unknown, context: string): PersonaTag[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array of tags`);
  }
  const out: PersonaTag[] = [];
  for (const [idx, entry] of value.entries()) {
    if (!isTag(entry)) {
      throw new Error(
        `${context}[${idx}] must be one of: ${PERSONA_TAGS.join(', ')}`
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function parseRuntime(value: unknown, context: string): PersonaRuntime {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { harness, model, systemPrompt, harnessSettings } = value;

  if (!isHarness(harness)) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  if (!isObject(harnessSettings)) {
    throw new Error(`${context}.harnessSettings must be an object`);
  }

  const { reasoning, timeoutSeconds } = harnessSettings;
  if (!['low', 'medium', 'high'].includes(String(reasoning))) {
    throw new Error(`${context}.harnessSettings.reasoning must be low|medium|high`);
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${context}.harnessSettings.timeoutSeconds must be a positive number`);
  }

  return {
    harness,
    model,
    systemPrompt,
    harnessSettings: {
      reasoning: reasoning as HarnessSettings['reasoning'],
      timeoutSeconds
    }
  };
}

function parseSkills(value: unknown, context: string): PersonaSkill[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }

  return value.map((entry, idx) => {
    const entryContext = `${context}[${idx}]`;
    if (!isObject(entry)) {
      throw new Error(`${entryContext} must be an object`);
    }
    const { id, source, description } = entry;
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(`${entryContext}.id must be a non-empty string`);
    }
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error(`${entryContext}.source must be a non-empty string`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error(`${entryContext}.description must be a non-empty string`);
    }
    return { id, source, description };
  });
}

function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): PersonaSpec {
  if (!isObject(value)) {
    throw new Error(`persona[${expectedIntent}] must be an object`);
  }

  const { id, intent, tags, description, tiers, skills, env, mcpServers, permissions } = value;

  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`persona[${expectedIntent}].id must be a non-empty string`);
  }
  if (!isIntent(intent)) {
    throw new Error(`persona[${expectedIntent}].intent is invalid`);
  }
  if (intent !== expectedIntent) {
    throw new Error(`persona[${expectedIntent}] intent mismatch: got ${intent}`);
  }
  const parsedTags = parseTags(tags, `persona[${expectedIntent}].tags`);
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`persona[${expectedIntent}].description must be a non-empty string`);
  }
  if (!isObject(tiers)) {
    throw new Error(`persona[${expectedIntent}].tiers must be an object`);
  }

  const parsedTiers = {} as Record<PersonaTier, PersonaRuntime>;
  for (const tier of PERSONA_TIERS) {
    parsedTiers[tier] = parseRuntime(tiers[tier], `persona[${expectedIntent}].tiers.${tier}`);
  }

  const parsedSkills = parseSkills(skills, `persona[${expectedIntent}].skills`);
  const parsedEnv = parseStringMap(env, `persona[${expectedIntent}].env`);
  const parsedMcpServers = parseMcpServers(mcpServers, `persona[${expectedIntent}].mcpServers`);
  const parsedPermissions = parsePermissions(
    permissions,
    `persona[${expectedIntent}].permissions`
  );

  return {
    id,
    intent,
    tags: parsedTags,
    description,
    skills: parsedSkills,
    tiers: parsedTiers,
    ...(parsedEnv ? { env: parsedEnv } : {}),
    ...(parsedMcpServers ? { mcpServers: parsedMcpServers } : {}),
    ...(parsedPermissions ? { permissions: parsedPermissions } : {})
  };
}

function parsePermissions(
  value: unknown,
  context: string
): PersonaPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: PersonaPermissions = {};
  const { allow, deny, mode } = value;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.allow must be an array of non-empty strings`);
    }
    out.allow = allow as string[];
  }
  if (deny !== undefined) {
    if (!Array.isArray(deny) || deny.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.deny must be an array of non-empty strings`);
    }
    out.deny = deny as string[];
  }
  if (mode !== undefined) {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
      throw new Error(
        `${context}.mode must be one of: ${PERMISSION_MODES.join(', ')}`
      );
    }
    out.mode = mode as PermissionMode;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStringMap(
  value: unknown,
  context: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`${context}.${key} must be a string`);
    }
    out[key] = v;
  }
  return out;
}

function parseMcpServers(
  value: unknown,
  context: string
): Record<string, McpServerSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, McpServerSpec> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isObject(raw)) {
      throw new Error(`${context}.${name} must be an object`);
    }
    const type = raw.type;
    if (type === 'http' || type === 'sse') {
      if (typeof raw.url !== 'string' || !raw.url.trim()) {
        throw new Error(`${context}.${name}.url must be a non-empty string for type=${type}`);
      }
      const headers = parseStringMap(raw.headers, `${context}.${name}.headers`);
      out[name] = { type, url: raw.url, ...(headers ? { headers } : {}) };
    } else if (type === 'stdio') {
      if (typeof raw.command !== 'string' || !raw.command.trim()) {
        throw new Error(`${context}.${name}.command must be a non-empty string for type=stdio`);
      }
      const args = raw.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
        throw new Error(`${context}.${name}.args must be an array of strings`);
      }
      const env = parseStringMap(raw.env, `${context}.${name}.env`);
      out[name] = {
        type: 'stdio',
        command: raw.command,
        ...(args ? { args: args as string[] } : {}),
        ...(env ? { env } : {})
      };
    } else {
      throw new Error(`${context}.${name}.type must be one of: http, sse, stdio`);
    }
  }
  return out;
}

function parseRoutingProfile(value: unknown, context: string): RoutingProfile {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { id, description, intents } = value;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${context}.description must be a non-empty string`);
  }
  if (!isObject(intents)) {
    throw new Error(`${context}.intents must be an object`);
  }

  const parsedIntents = {} as Record<PersonaIntent, RoutingProfileRule>;
  for (const intent of PERSONA_INTENTS) {
    const rule = intents[intent];
    if (!isObject(rule)) {
      throw new Error(`${context}.intents.${intent} must be an object`);
    }
    const { tier, rationale } = rule;
    if (!isTier(tier)) {
      throw new Error(`${context}.intents.${intent}.tier must be one of: ${PERSONA_TIERS.join(', ')}`);
    }
    if (typeof rationale !== 'string' || !rationale.trim()) {
      throw new Error(`${context}.intents.${intent}.rationale must be a non-empty string`);
    }
    parsedIntents[intent] = { tier, rationale };
  }

  return {
    id,
    description,
    intents: parsedIntents
  };
}

export const personaCatalog: Record<PersonaIntent, PersonaSpec> = {
  'implement-frontend': parsePersonaSpec(frontendImplementer, 'implement-frontend'),
  review: parsePersonaSpec(codeReviewer, 'review'),
  'architecture-plan': parsePersonaSpec(architecturePlanner, 'architecture-plan'),
  'requirements-analysis': parsePersonaSpec(requirementsAnalyst, 'requirements-analysis'),
  debugging: parsePersonaSpec(debuggerPersona, 'debugging'),
  'security-review': parsePersonaSpec(securityReviewer, 'security-review'),
  documentation: parsePersonaSpec(technicalWriter, 'documentation'),
  verification: parsePersonaSpec(verifierPersona, 'verification'),
  'test-strategy': parsePersonaSpec(testStrategist, 'test-strategy'),
  'tdd-enforcement': parsePersonaSpec(tddGuard, 'tdd-enforcement'),
  'flake-investigation': parsePersonaSpec(flakeHunter, 'flake-investigation'),
  'opencode-workflow-correctness': parsePersonaSpec(
    opencodeWorkflowSpecialist,
    'opencode-workflow-correctness'
  ),
  'npm-provenance': parsePersonaSpec(npmProvenancePublisher, 'npm-provenance'),
  'cloud-sandbox-infra': parsePersonaSpec(cloudSandboxInfra, 'cloud-sandbox-infra'),
  'sage-slack-egress-migration': parsePersonaSpec(
    sageSlackEgressMigrator,
    'sage-slack-egress-migration'
  ),
  'sage-proactive-rewire': parsePersonaSpec(sageProactiveRewirer, 'sage-proactive-rewire'),
  'cloud-slack-proxy-guard': parsePersonaSpec(cloudSlackProxyGuard, 'cloud-slack-proxy-guard'),
  'sage-cloud-e2e-conduction': parsePersonaSpec(
    agentRelayE2eConductor,
    'sage-cloud-e2e-conduction'
  ),
  'capability-discovery': parsePersonaSpec(capabilityDiscoverer, 'capability-discovery'),
  posthog: parsePersonaSpec(posthogAgent, 'posthog')
};

export const routingProfiles = {
  default: parseRoutingProfile(defaultRoutingProfileJson, 'routingProfiles.default')
} as const;

export type RoutingProfileId = keyof typeof routingProfiles;

export function resolvePersona(intent: PersonaIntent, profile: RoutingProfile | RoutingProfileId = 'default'): PersonaSelection {
  const profileSpec = typeof profile === 'string' ? routingProfiles[profile] : profile;
  const rule = profileSpec.intents[intent];
  const spec = personaCatalog[intent];

  return {
    personaId: spec.id,
    tier: rule.tier,
    runtime: spec.tiers[rule.tier],
    skills: spec.skills,
    rationale: `${profileSpec.id}: ${rule.rationale}`,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {})
  };
}

/**
 * Backward-compatible helper for callers that already selected a tier directly.
 * Prefer resolvePersona(intent, profile) for policy-driven selection.
 */
export function resolvePersonaByTier(intent: PersonaIntent, tier: PersonaTier = 'best-value'): PersonaSelection {
  const spec = personaCatalog[intent];
  return {
    personaId: spec.id,
    tier,
    runtime: spec.tiers[tier],
    skills: spec.skills,
    rationale: `legacy-tier-override: ${tier}`,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {})
  };
}

/**
 * Resolve a persona for `intent` and return a {@link PersonaContext}
 * bundling the resolved persona, grouped install metadata, and a
 * `sendMessage()` closure for running the persona against a task.
 *
 * **This is not a React hook.** The `use*` prefix is unfortunate — it is
 * a plain synchronous factory with no implicit state, no side effects,
 * and no rules-of-hooks constraints. Calling `usePersona(intent)` does
 * nothing but resolve routing config and pre-compute the install plan.
 * Nothing is installed, spawned, or written to disk until you call
 * `sendMessage()` (or run the install command yourself).
 *
 * See {@link PersonaContext} for the two usage modes (let `sendMessage()`
 * handle install vs. pre-stage install and pass `installSkills: false`)
 * and the double-install caveat.
 *
 * @example
 * // Mode A — let sendMessage() install skills and run the agent in one call.
 * // Only `status: 'completed'` resolves; non-zero exits / timeouts throw
 * // PersonaExecutionError and cancellation throws AbortError, both with
 * // the typed ExecuteResult attached as `err.result`.
 * const { sendMessage } = usePersona('npm-provenance');
 * try {
 *   const result = await sendMessage('Set up npm trusted publishing for this repo', {
 *     workingDirectory: '.',
 *     timeoutSeconds: 600,
 *   });
 *   // result.status === 'completed' here
 * } catch (err) {
 *   const execErr = err as Error & { result?: ExecuteResult };
 *   console.error('persona run failed', execErr.result?.status, execErr.result?.stderr);
 * }
 *
 * @example
 * // Mode B — pre-stage install out-of-band (e.g. in a Dockerfile), then
 * // run at runtime without re-installing:
 * const { install, sendMessage } = usePersona('npm-provenance');
 * // build/CI step:
 * spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
 * // runtime step:
 * const result = await sendMessage('Your task', {
 *   workingDirectory: '.',
 *   installSkills: false,
 * });
 *
 * @example
 * // Cancellation + streaming progress. Aborting causes `await run` to
 * // throw an AbortError with `err.result.status === 'cancelled'`, so
 * // wrap in try/catch if you plan to abort.
 * const abort = new AbortController();
 * const run = usePersona('npm-provenance').sendMessage('Your task', {
 *   signal: abort.signal,
 *   onProgress: ({ stream, text }) => process[stream].write(text),
 * });
 * run.runId.then((id) => console.log('workflow run id:', id));
 * // ...later:
 * abort.abort(); // or: run.cancel('user requested');
 * try {
 *   const result = await run;
 *   // result.status === 'completed'
 * } catch (err) {
 *   const execErr = err as Error & { result?: ExecuteResult };
 *   // execErr.name === 'AbortError' and execErr.result?.status === 'cancelled'
 * }
 *
 * @param intent   The persona intent to resolve (e.g. `'npm-provenance'`).
 * @param options  Optional overrides. `harness` forces a specific harness
 *                 (otherwise inferred from the selected tier's runtime).
 *                 `tier` bypasses profile-driven routing and selects a tier
 *                 directly (legacy path — prefer `profile`). `profile`
 *                 selects the routing profile (defaults to `'default'`).
 */
export function usePersona(
  intent: PersonaIntent,
  options: {
    harness?: Harness;
    tier?: PersonaTier;
    profile?: RoutingProfile | RoutingProfileId;
    /**
     * Stage claude skills under this absolute directory instead of the
     * repo's `.claude/skills/`. See {@link SkillMaterializationOptions.installRoot}.
     */
    installRoot?: string;
  } = {}
): PersonaContext {
  const baseSelection = options.tier
    ? resolvePersonaByTier(intent, options.tier)
    : resolvePersona(intent, options.profile ?? 'default');

  return useSelection(baseSelection, {
    harness: options.harness,
    installRoot: options.installRoot
  });
}

/**
 * Same as {@link usePersona}, but takes a pre-resolved {@link PersonaSelection}
 * instead of an intent. Use this when you have a selection produced outside
 * the standard repo catalog — for example, a user-local persona override
 * loaded from disk — and want the same install/sendMessage surface.
 */
export function useSelection(
  baseSelection: PersonaSelection,
  options: { harness?: Harness; installRoot?: string } = {}
): PersonaContext {
  const effectiveHarness = options.harness ?? baseSelection.runtime.harness;
  const selection =
    effectiveHarness === baseSelection.runtime.harness
      ? baseSelection
      : {
          ...baseSelection,
          runtime: {
            ...baseSelection.runtime,
            harness: effectiveHarness
          }
        };

  const materializationOptions: SkillMaterializationOptions =
    options.installRoot !== undefined ? { installRoot: options.installRoot } : {};
  const installPlan =
    effectiveHarness === baseSelection.runtime.harness
      ? materializeSkillsFor(selection, materializationOptions)
      : materializeSkills(selection.skills, effectiveHarness, materializationOptions);

  const { installCommand, installCommandString } = buildInstallArtifacts(installPlan);
  const { cleanupCommand, cleanupCommandString } = buildCleanupArtifacts(installPlan);
  const frozenSelection = deepFreeze(selection);
  const frozenInstallPlan = deepFreeze(installPlan);
  const frozenInstall: PersonaInstallContext = Object.freeze({
    plan: frozenInstallPlan,
    command: installCommand,
    commandString: installCommandString,
    cleanupCommand,
    cleanupCommandString
  });

  const sendMessage = (task: string, sendMessageOptions: ExecuteOptions = {}): PersonaExecution => {
    const runId = createDeferred<string>();
    // The primary rejection path for any failure in sendMessage() is `resultPromise`
    // (which the caller awaits via `await execution`). `runId.promise` is an
    // auxiliary promise that mirrors the same rejection when early setup fails
    // before the workflow has actually started. Callers are not required to
    // consume `execution.runId`, so attach a no-op catch here to suppress
    // the unhandled-rejection warning (and, under Node's default
    // --unhandled-rejections=throw, an uncaught-exception crash) that would
    // otherwise fire when both of those conditions hold simultaneously.
    runId.promise.catch(() => {});
    const abortController = new AbortController();
    const unlinkAbort = linkAbortSignal(sendMessageOptions.signal, abortController);
    const stepName = sanitizeExecutionName(
      sendMessageOptions.name ?? `${frozenSelection.personaId}-${hash8(task)}`
    );
    const workflowName = `use-persona-${stepName}`;
    const installStepName = `${stepName}-install-skills`;
    const cleanupStepName = `${stepName}-cleanup-skills`;
    const workingDirectory = resolvePath(sendMessageOptions.workingDirectory ?? process.cwd());
    const timeoutMs = Math.max(
      1,
      Math.round(
        (sendMessageOptions.timeoutSeconds ??
          frozenSelection.runtime.harnessSettings.timeoutSeconds) * 1000
      )
    );
    const shouldInstallSkills =
      sendMessageOptions.installSkills !== false && frozenInstallPlan.installs.length > 0;
    const stepCaptures = new Map<string, CommandCapture>();
    let cancelReason: string | undefined;
    let workflowRunId: string | undefined;
    let runIdReadyTimer: NodeJS.Timeout | undefined;

    const resolveRunId = (value = workflowRunId) => {
      if (runIdReadyTimer) {
        clearTimeout(runIdReadyTimer);
        runIdReadyTimer = undefined;
      }
      if (value && !runId.settled) {
        runId.resolve(value);
      }
    };

    const resultPromise = (async (): Promise<ExecuteResult> => {
      try {
        const { InMemoryWorkflowDb, WorkflowRunner, buildCommand, workflow } = await import(
          '@agent-relay/sdk/workflows'
        );
        const executor = createLocalExecutor(
          stepCaptures,
          {
            cwd: workingDirectory,
            env: { ...process.env, ...sendMessageOptions.env },
            signal: abortController.signal,
            onStepSpawn: (startedStepName) => {
              if (startedStepName !== stepName || runId.settled || runIdReadyTimer) {
                return;
              }

              runIdReadyTimer = setTimeout(() => resolveRunId(), 250);
              runIdReadyTimer.unref?.();
            },
            onStepProgress: (progressStepName) => {
              if (progressStepName === stepName) {
                resolveRunId();
              }
            },
            onProgress: sendMessageOptions.onProgress
          },
          buildCommand
        );
        const runner = new WorkflowRunner({
          cwd: workingDirectory,
          db: new InMemoryWorkflowDb(),
          executor
        });

        runner.on((event) => {
          if (event.type === 'run:started') {
            workflowRunId = event.runId;
          }

          if (
            (event.type === 'step:completed' || event.type === 'step:failed') &&
            event.stepName === stepName
          ) {
            resolveRunId(event.runId);
          }
        });

        const agentName = `${stepName}-agent`;
        const builder = workflow(workflowName)
          .description(`Ad-hoc persona execution for ${frozenSelection.personaId}`)
          .pattern('dag')
          .timeout(timeoutMs)
          .trajectories(false)
          .agent(agentName, {
            cli: frozenSelection.runtime.harness,
            model: frozenSelection.runtime.model,
            role: frozenSelection.personaId,
            preset: 'worker',
            interactive: false,
            timeoutMs
          });

        if (shouldInstallSkills) {
          builder.step(installStepName, {
            type: 'deterministic',
            command: installCommandString,
            cwd: workingDirectory,
            timeoutMs,
            captureOutput: true,
            failOnError: true
          });
        }

        builder.step(stepName, {
          agent: agentName,
          task: buildExecutionTask(
            frozenSelection.runtime.systemPrompt,
            task,
            sendMessageOptions.inputs
          ),
          cwd: workingDirectory,
          timeoutMs,
          verification: { type: 'exit_code', value: '0' },
          ...(shouldInstallSkills ? { dependsOn: [installStepName] } : {})
        });

        // Post-agent cleanup: removes the ephemeral skill artifact paths the
        // provider scattered during the install step. Only runs when this
        // sendMessage owns the install (Mode A) AND the agent step completed
        // — if the agent step fails or is skipped, the dag runner will skip
        // this step too, which is fine because (a) failure diagnostics stay
        // on disk for the user to inspect, and (b) `rm -rf` is idempotent so
        // a follow-up run can re-clean. The lockfile is deliberately not in
        // cleanupPaths, so repeat runs still benefit from cached resolution.
        if (shouldInstallSkills && frozenInstall.cleanupCommandString !== ':') {
          builder.step(cleanupStepName, {
            type: 'deterministic',
            command: frozenInstall.cleanupCommandString,
            cwd: workingDirectory,
            timeoutMs,
            captureOutput: true,
            failOnError: false,
            dependsOn: [stepName]
          });
        }

        if (abortController.signal.aborted) {
          runner.abort();
        } else {
          abortController.signal.addEventListener('abort', () => runner.abort(), { once: true });
        }
        const run = (await runner.execute(builder.toConfig())) as WorkflowRunRow;
        if (!runId.settled) {
          runId.resolve(run.id);
        }

        const primaryCapture = stepCaptures.get(stepName);
        const fallbackCapture = shouldInstallSkills ? stepCaptures.get(installStepName) : undefined;
        const capture = primaryCapture ?? fallbackCapture;
        const result: ExecuteResult = {
          status:
            run.status === 'cancelled'
              ? 'cancelled'
              : run.status === 'failed' && isTimeoutError(run.error)
                ? 'timeout'
                : run.status === 'completed'
                  ? 'completed'
                  : 'failed',
          output: capture?.stdout ?? '',
          stderr: capture?.stderr ?? '',
          exitCode: capture?.exitCode ?? null,
          durationMs: Date.now() - (Date.parse(run.startedAt) || Date.now()),
          workflowRunId: run.id,
          stepName
        };

        if (run.status === 'completed') {
          return result;
        }

        if (run.status === 'cancelled') {
          const error = createAbortError(cancelReason ?? 'Execution cancelled');
          Object.assign(error, { result });
          throw error;
        }

        throw new PersonaExecutionError(
          run.error ?? `Persona execution failed for step "${stepName}"`,
          result
        );
      } catch (error) {
        if (!runId.settled) {
          runId.reject(error);
        }
        throw error;
      } finally {
        if (runIdReadyTimer) {
          clearTimeout(runIdReadyTimer);
        }
        unlinkAbort();
      }
    })();

    return Object.assign(resultPromise, {
      cancel(reason?: string) {
        cancelReason = reason;
        abortController.abort(reason);
      },
      runId: runId.promise
    }) as PersonaExecution;
  };

  return Object.freeze({
    selection: frozenSelection,
    install: frozenInstall,
    sendMessage
  });
}

export * from './eval.js';
