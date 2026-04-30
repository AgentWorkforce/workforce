import { frontendImplementer, codeReviewer, architecturePlanner, requirementsAnalyst, debuggerPersona, securityReviewer, technicalWriter, verifierPersona, testStrategist, tddGuard, flakeHunter, opencodeWorkflowSpecialist, npmProvenancePublisher, cloudSandboxInfra, sageSlackEgressMigrator, sageProactiveRewirer, cloudSlackProxyGuard, agentRelayE2eConductor, capabilityDiscoverer, npmPackageBundlerGuard, posthogAgent, personaMaker, antiSlopAuditor, apiContractReviewer, dockerStackWrangler, e2eValidator, integrationTestAuthor, agentRelayWorkflow, relayOrchestrator } from './generated/personas.js';
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
  'npm-package-compat',
  'posthog',
  'persona-authoring',
  'agent-relay-workflow',
  'slop-audit',
  'api-contract-review',
  'local-stack-orchestration',
  'e2e-validation',
  'write-integration-tests',
  'relay-orchestrator'
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
 * harness throws. The caller must supply an absolute path; when the generated
 * install command runs, it `mkdir -p`s `installRoot` and any missing parents
 * needed for the scaffold (`.claude-plugin/`, `.claude/skills/`).
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
   * in place. Callers running the install themselves should run this **after**
   * the agent step consumes the skills, never before. For empty plans this is
   * a shell no-op (`:`).
   */
  readonly cleanupCommand: readonly string[];
  /** Shell-escaped form of {@link cleanupCommand}. */
  readonly cleanupCommandString: string;
}

/**
 * Return value of {@link usePersona}. A side-effect-free bundle of "what this
 * persona is" plus grouped install metadata. Nothing is installed, spawned, or
 * written to disk by constructing this object — run `install.commandString`
 * yourself when you are ready to materialize the persona's skills.
 */
export interface PersonaContext {
  /** Resolved persona choice for this intent/profile: identity, tier, runtime, skills, and routing rationale. */
  readonly selection: PersonaSelection;
  /** Grouped install metadata for the resolved persona's skills. */
  readonly install: PersonaInstallContext;
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
    // per-skill cleanupPaths empty so callers running individual
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
  'npm-package-compat': parsePersonaSpec(npmPackageBundlerGuard, 'npm-package-compat'),
  posthog: parsePersonaSpec(posthogAgent, 'posthog'),
  'persona-authoring': parsePersonaSpec(personaMaker, 'persona-authoring'),
  'agent-relay-workflow': parsePersonaSpec(agentRelayWorkflow, 'agent-relay-workflow'),
  'slop-audit': parsePersonaSpec(antiSlopAuditor, 'slop-audit'),
  'api-contract-review': parsePersonaSpec(apiContractReviewer, 'api-contract-review'),
  'local-stack-orchestration': parsePersonaSpec(dockerStackWrangler, 'local-stack-orchestration'),
  'e2e-validation': parsePersonaSpec(e2eValidator, 'e2e-validation'),
  'write-integration-tests': parsePersonaSpec(integrationTestAuthor, 'write-integration-tests'),
  'relay-orchestrator': parsePersonaSpec(relayOrchestrator, 'relay-orchestrator')
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
 * bundling the resolved persona and grouped install metadata.
 *
 * **This is not a React hook.** The `use*` prefix is unfortunate — it is
 * a plain synchronous factory with no implicit state, no side effects,
 * and no rules-of-hooks constraints. Calling `usePersona(intent)` does
 * nothing but resolve routing config and pre-compute the install plan.
 * Nothing is installed, spawned, or written to disk until you run
 * `install.commandString` yourself.
 *
 * @example
 * const { selection, install } = usePersona('npm-provenance');
 * spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
 * // hand `selection` to your harness launcher of choice.
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
 * loaded from disk.
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

  return Object.freeze({
    selection: frozenSelection,
    install: frozenInstall
  });
}

export * from './eval.js';
