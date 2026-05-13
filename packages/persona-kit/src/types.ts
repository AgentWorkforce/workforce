import type {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  PERSONA_TAGS,
  SIDECAR_MD_MODES,
  SKILL_SOURCE_KINDS
} from './constants.js';

export type Harness = (typeof HARNESS_VALUES)[number];
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
  /**
   * Emit codex's single `--dangerously-bypass-approvals-and-sandbox` flag,
   * which collapses "no sandbox + never ask for approval" and also
   * suppresses codex's interactive "are you sure?" startup confirmation.
   * Mutually exclusive with `sandboxMode`, `approvalPolicy`, and
   * `workspaceWriteNetworkAccess` — those translate to the two-flag form
   * which still prompts.
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
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

/**
 * A single event trigger declared by an integration. `on` is a Relayfile-
 * adapter-normalized event name (e.g. `pull_request.opened`,
 * `issue.created`, `app_mention`). `match` and `where` are filter sugars
 * the deploy CLI lints against a known registry; unknown values warn but
 * do not fail parse, so the cloud runtime stays the source of truth.
 *
 * Examples:
 *   { on: "pull_request.opened" }
 *   { on: "issue_comment.created", match: "@mention" }
 *   { on: "check_run.completed", where: "conclusion=failure" }
 */
export interface PersonaIntegrationTrigger {
  on: string;
  match?: string;
  where?: string;
}

/**
 * Per-provider integration configuration. The map key is the Relayfile
 * provider slug (`github`, `linear`, `slack`, `notion`, `jira`). `scope`
 * is provider-specific filter metadata (e.g. `{ repo: "org/repo" }` for
 * github, `{ database: "<id>" }` for notion). `triggers` are flat — all
 * trigger events for this provider fan into the same `onEvent` handler,
 * which discriminates on `event.source` + `event.type`.
 */
export interface PersonaIntegrationConfig {
  scope?: Record<string, string>;
  triggers?: PersonaIntegrationTrigger[];
}

/**
 * A cron-style schedule. `name` is unique within the persona and surfaces
 * to the handler as `event.name`. `cron` is a standard 5-field expression.
 * `tz` defaults to `UTC` at the runtime layer (the parser keeps it
 * optional so the spec stays close to what the author wrote).
 */
export interface PersonaSchedule {
  name: string;
  cron: string;
  tz?: string;
}

/**
 * Long-form sandbox configuration. `enabled` defaults to true when the
 * object form is present; supply the boolean shorthand `sandbox: false`
 * to opt out entirely. `timeoutSeconds` caps a single handler invocation
 * (default 1800s in the runtime). `env` is merged on top of auto-injected
 * secrets at sandbox-create time.
 *
 * Image selection is intentionally not user-configurable in v1 — workforce
 * picks a standard image. Add `image` later if a real demand surfaces.
 */
export interface PersonaSandboxConfig {
  enabled?: boolean;
  timeoutSeconds?: number;
  env?: Record<string, string>;
}

/**
 * Sandbox can be specified as `true` / `false` shorthand or as the full
 * config object. The parser preserves whichever form the author wrote so
 * round-trips stay lossless; consumers normalize when reading.
 */
export type PersonaSandbox = boolean | PersonaSandboxConfig;

/** Memory scope semantics, mirroring @agent-assistant/memory. */
export type PersonaMemoryScope = 'session' | 'user' | 'workspace' | 'org' | 'object';

/**
 * Long-form memory configuration. Defaults are applied by the runtime,
 * not the parser — the spec keeps only what the author actually wrote.
 * `enabled` defaults to true when the object form is present.
 */
export interface PersonaMemoryConfig {
  enabled?: boolean;
  scopes?: PersonaMemoryScope[];
  ttlDays?: number;
  autoPromote?: boolean;
  dedupMs?: number;
}

export type PersonaMemory = boolean | PersonaMemoryConfig;

/**
 * Conversational traits, applied only when the agent posts to a chat
 * surface (Slack, Relaycast, GitHub PR comment). Headless agents — the
 * paraglide "Linear issue → PR" pattern — should omit this field. Mirrors
 * the trait shape in `@agent-assistant/traits`.
 */
export interface PersonaTraits {
  voice?: string;
  formality?: 'low' | 'medium' | 'high';
  proactivity?: 'low' | 'medium' | 'high';
  riskPosture?: 'conservative' | 'balanced' | 'aggressive';
  domain?: string;
  vocabulary?: string[];
  preferMarkdown?: boolean;
}

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
  /** Harness binary used to run this persona (`claude`, `codex`, `opencode`). */
  harness: Harness;
  /** Model identifier passed to the harness. */
  model: string;
  /** System prompt body. `$NAME` / `${NAME}` references to inputs are substituted at spawn time. */
  systemPrompt: string;
  /** Harness-level knobs (reasoning, timeout, codex sandbox/approval policy, etc.). */
  harnessSettings: HarnessSettings;
  /**
   * Environment variables injected into the harness child process.
   * Values may be literal strings or `$VAR` references resolved from the
   * caller's environment at spawn time.
   */
  env?: Record<string, string>;
  /**
   * MCP servers to attach to the harness session.
   * - `claude`: passed via `--mcp-config`
   * - `codex`: translated into `--config mcp_servers.<name>...` overrides
   * - `opencode`: currently warns and skips
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
   * the content into {@link PersonaSpec.claudeMdContent} at build time.
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
  /**
   * Inlined `CLAUDE.md` content for built-in personas. The catalog generator
   * reads the sibling `.md` at build time and emits its body here so the
   * installed package does not need to ship the file separately. Runtime
   * code prefers this over `claudeMd` when both are set.
   */
  claudeMdContent?: string;
  /** Inlined `AGENTS.md` content for built-in personas. */
  agentsMdContent?: string;
  /**
   * Opt this persona into the `workforce deploy` cloud-agent surface.
   * When `true`, the deploy CLI considers this persona a deployable agent
   * (validates {@link integrations} / {@link schedules}, prompts for
   * integration connect, bundles {@link onEvent}, hands off to the runtime).
   * Local `workforce agent <id>` flows ignore this flag — non-deploy use
   * keeps working unchanged.
   */
  cloud?: boolean;
  /**
   * When `true`, inference for this agent uses the user's connected LLM
   * subscription via `@agent-relay/cloud`'s provider link, rather than
   * workforce-billed tokens. The deploy CLI calls `connectProvider({...})`
   * at deploy time. Only meaningful when {@link cloud} is `true`.
   */
  useSubscription?: boolean;
  /**
   * Per-provider integration declarations keyed by Relayfile provider slug
   * (`github`, `linear`, `slack`, `notion`, `jira`). At deploy time the CLI
   * runs `RelayfileSetup.connectIntegration({ allowedIntegrations: [key] })`
   * for each provider not yet connected to the active workspace.
   */
  integrations?: Record<string, PersonaIntegrationConfig>;
  /** Cron-style schedules. Each `name` is unique within the persona. */
  schedules?: PersonaSchedule[];
  /**
   * Sandbox preference. `true` (default for cloud personas) means the
   * agent runs inside a Daytona sandbox at deploy time; `false` runs it in
   * the runner process. The object form lets the author tune timeout / env.
   */
  sandbox?: PersonaSandbox;
  /**
   * Memory subsystem opt-in. Wires the agent-assistant memory adapter at
   * runtime; the persona spec only declares intent, not implementation
   * details (api keys, adapter type, etc. come from workforce env).
   */
  memory?: PersonaMemory;
  /**
   * Conversational traits, applied only when the agent posts to a chat
   * surface. Omit for headless agents.
   */
  traits?: PersonaTraits;
  /**
   * Relative POSIX path to the TypeScript (or compiled .js / .mjs) file
   * whose default export is the deploy-time event handler. Resolved
   * relative to the persona JSON's directory at deploy time. Required when
   * {@link cloud} is `true` and any trigger is declared; the deploy CLI
   * enforces this at deploy time, the parser keeps it optional so partially-
   * authored specs still parse.
   */
  onEvent?: string;
}

export interface PersonaSelection {
  personaId: string;
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
  skills: PersonaSkill[];
  rationale: string;
  inputs?: Record<string, PersonaInputSpec>;
  inputValues?: Record<string, string>;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
  mount?: PersonaMount;
  /**
   * Effective sidecar config for the persona. Modes default to `overwrite`
   * when a path or inlined content exists; otherwise the mode field is omitted.
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
  /** Resolved persona choice for this intent/profile: identity, runtime, skills, and routing rationale. */
  readonly selection: PersonaSelection;
  /** Grouped install metadata for the resolved persona's skills. */
  readonly install: PersonaInstallContext;
}
