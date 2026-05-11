import type {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  PERSONA_TAGS,
  PERSONA_TIERS,
  SIDECAR_MD_MODES,
  SKILL_SOURCE_KINDS
} from './constants.js';

export type Harness = (typeof HARNESS_VALUES)[number];
export type PersonaTier = (typeof PERSONA_TIERS)[number];
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];
export type PersonaTag = (typeof PERSONA_TAGS)[number];
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export type SidecarMdMode = (typeof SIDECAR_MD_MODES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export interface HarnessSettings {
  reasoning: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
  /**
   * Codex CLI sandbox mode for model-generated shell commands. Prefer
   * `workspace-write` with `workspaceWriteNetworkAccess` when network is the only
   * missing capability; `danger-full-access` is the fully unsandboxed fallback.
   */
  sandboxMode?: CodexSandboxMode;
  /** Codex CLI approval policy (`--ask-for-approval`). */
  approvalPolicy?: CodexApprovalPolicy;
  /**
   * Allow outbound network access inside Codex's workspace-write sandbox
   * (`sandbox_workspace_write.network_access`).
   */
  workspaceWriteNetworkAccess?: boolean;
  /** Enable the Codex live web-search tool for this runtime. */
  webSearch?: boolean;
}

export interface PersonaRuntime {
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
  /**
   * Per-tier override of the persona's `claudeMd` path. Resolves to an
   * absolute filesystem path on the parsed spec — for built-ins, the value
   * comes from `claudeMdContent` instead of a path. Materialized into the
   * sandbox mount as `/CLAUDE.md` when running under the claude harness.
   */
  claudeMd?: string;
  /** Per-tier override of {@link PersonaSpec.claudeMdMode}. */
  claudeMdMode?: SidecarMdMode;
  /** Per-tier override of the persona's `agentsMd` path. */
  agentsMd?: string;
  /** Per-tier override of {@link PersonaSpec.agentsMdMode}. */
  agentsMdMode?: SidecarMdMode;
  /**
   * Inlined sidecar content for built-in personas. The catalog generator
   * reads the sibling `.md` at build time and emits its body here so the
   * installed package does not need to ship the file separately. Runtime
   * code prefers this over `claudeMd` when both are set.
   */
  claudeMdContent?: string;
  /** Inlined `AGENTS.md` content for built-in personas (see {@link claudeMdContent}). */
  agentsMdContent?: string;
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

/**
 * Prompt-visible runtime input declared by a persona. Inputs are for
 * non-secret run configuration such as output paths, target package names, or
 * mode switches. Launchers resolve each input from explicit values, the
 * process environment, or `default`, then substitute `$NAME` / `${NAME}` in
 * the system prompt before spawning the harness.
 */
export interface PersonaInputSpec {
  /** Human-readable explanation shown in docs/catalog UIs. */
  description?: string;
  /**
   * Environment variable to read when the launcher did not provide an
   * explicit value. Defaults to the input key itself.
   */
  env?: string;
  /** Literal fallback used when neither an explicit value nor env var exists. */
  default?: string;
  /**
   * When true, the input is allowed to resolve to an empty string. The
   * launcher substitutes `$NAME` with `''` rather than throwing
   * `MissingPersonaInputError`. Use for inputs whose absence is meaningful
   * — e.g. an upstream task description that may or may not be forwarded —
   * and prefer non-optional inputs with a `default` for everything else so
   * misconfigured launches surface loudly.
   */
  optional?: boolean;
}

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
 * Relayfile mount policy for interactive sessions. Patterns use gitignore
 * syntax. `ignoredPatterns` are omitted from the mount entirely;
 * `readonlyPatterns` are copied into the mount but edits do not sync back.
 * Launchers may merge these with project-level `.agentignore` /
 * `.agentreadonly` dotfiles.
 */
export interface PersonaMount {
  ignoredPatterns?: string[];
  readonlyPatterns?: string[];
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
  intent: string;
  /**
   * Free-form classification labels (from {@link PERSONA_TAGS}). Every persona
   * has at least one; a persona may carry multiple tags when it spans concerns
   * (e.g. `['testing', 'implementation']`).
   */
  tags: PersonaTag[];
  description: string;
  skills: PersonaSkill[];
  /**
   * Prompt-visible runtime inputs. Keys must be env-style names
   * (`OUTPUT_PATH`, `TARGET_DIR`, etc.). Never put secrets here; resolved
   * values are substituted into the persona's system prompt.
   */
  inputs?: Record<string, PersonaInputSpec>;
  tiers: Record<PersonaTier, PersonaRuntime>;
  /**
   * Persona-author's preferred tier when a caller does not request one
   * explicitly. Selectors like `agentworkforce agent <persona>` (no `@<tier>`
   * suffix) resolve to this value before falling back to `'best-value'`.
   * Routing-profile rules continue to override this for built-in personas
   * resolved through {@link resolvePersona}.
   */
  defaultTier?: PersonaTier;
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
  /**
   * Relayfile mount policy for file visibility and writability. Applied by
   * launchers that run the harness inside `@relayfile/local-mount`.
   */
  mount?: PersonaMount;
  /**
   * Author-supplied path to a `CLAUDE.md` sidecar that should be applied
   * when the persona runs under the claude harness. The path is relative
   * to the JSON file that declared the field; the loader resolves it to
   * an already-absolute path on the parsed spec. Built-in personas inline
   * the content into {@link PersonaRuntime.claudeMdContent} at build time.
   */
  claudeMd?: string;
  /** Defaults to `overwrite`. See {@link SidecarMdMode}. */
  claudeMdMode?: SidecarMdMode;
  /**
   * Author-supplied path to an `AGENTS.md` sidecar that should be applied
   * when the persona runs under the opencode harness. Same resolution
   * rules as {@link claudeMd}.
   */
  agentsMd?: string;
  /** Defaults to `overwrite`. See {@link SidecarMdMode}. */
  agentsMdMode?: SidecarMdMode;
  /** Inlined `CLAUDE.md` content for built-in personas (see {@link PersonaRuntime.claudeMdContent}). */
  claudeMdContent?: string;
  /** Inlined `AGENTS.md` content for built-in personas. */
  agentsMdContent?: string;
}

export interface PersonaSelection {
  personaId: string;
  tier: PersonaTier;
  runtime: PersonaRuntime;
  skills: PersonaSkill[];
  rationale: string;
  inputs?: Record<string, PersonaInputSpec>;
  inputValues?: Record<string, string>;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
  mount?: PersonaMount;
  /**
   * Effective sidecar config for the selected (tier, harness). Already-
   * cascaded across top-level/per-tier so launchers don't have to re-walk
   * the spec. Modes default to `overwrite`.
   */
  claudeMd?: string;
  claudeMdContent?: string;
  claudeMdMode?: SidecarMdMode;
  agentsMd?: string;
  agentsMdContent?: string;
  agentsMdMode?: SidecarMdMode;
}

/** Per-harness rules for where skills land on disk and how to ask prpm for them. */
export interface HarnessSkillTarget {
  /** Value passed to `prpm install --as <flag>`. */
  asFlag: string;
  /** Directory (relative to repo root) where prpm drops the skill package. */
  dir: string;
}

/**
 * Options for {@link materializeSkills} / {@link materializeSkillsFor}.
 *
 * `installRoot` stages skills under an out-of-repo directory (typically
 * `~/.agentworkforce/workforce/sessions/<id>/claude/plugin`) that doubles as a Claude
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
  /**
   * Filesystem root that relative `local`-kind skill sources are resolved
   * against. When set, the local provider absolute-ifies a source like
   * `.agentworkforce/workforce/skills/foo.md` to `<repoRoot>/.agentworkforce/...`
   * before embedding it into the install command, so the `cp` survives the
   * `cd <installRoot>` prefix that session-mode installs add. Has no effect on
   * `prpm` / `skill.sh` skills. When unset, local sources are embedded as-is
   * and resolve against whatever cwd the caller runs the install command in.
   */
  repoRoot?: string;
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
  /**
   * Echoed from {@link SkillMaterializationOptions.repoRoot} so downstream
   * artifact builders (`buildInstallArtifacts`) can re-resolve `local` skill
   * sources to the same absolute paths the per-install commands embedded.
   */
  repoRoot?: string;
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
