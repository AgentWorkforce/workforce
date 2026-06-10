import type {
  Harness,
  HarnessSettings,
  McpServerSpec,
  PersonaPermissions,
  PersonaRelay
} from './types.js';

/**
 * A config file the caller should materialize before launching the harness.
 * Paths are relative to the harness's cwd — typically the mount dir when a
 * sandbox is in use, otherwise process.cwd(). Pure data, no I/O here.
 */
export interface InteractiveConfigFile {
  /** Relative path (from cwd) where the file should be written. */
  path: string;
  /** Exact file contents, already serialized. */
  contents: string;
}

/** Result of translating a persona's runtime into a spawnable command. */
export interface InteractiveSpec {
  /** Binary to exec (e.g. `claude`, `codex`, `opencode`, `grok`). */
  bin: string;
  /** Argv for the binary, in order. Callers should `spawn(bin, args)`. */
  args: readonly string[];
  /**
   * If set, the caller should append this as the final positional argument
   * — used by harnesses that don't support a separate system-prompt flag
   * to carry the persona's system prompt as the initial user prompt.
   * Currently only codex takes this path; claude uses `--append-system-prompt`,
   * opencode writes the prompt into `opencode.json` (see `configFiles`), and
   * grok writes the prompt into `AGENTS.md` (see `configFiles`).
   */
  initialPrompt: string | null;
  /**
   * Non-fatal warnings produced during translation — e.g. "codex doesn't
   * support MCP yet, ignoring". Callers decide whether to print them.
   */
  warnings: string[];
  /**
   * Config files the caller must write (relative to the harness cwd) before
   * launch. Opencode uses this to materialize an `opencode.json` carrying
   * the persona's agent definition (model + system prompt) so `--agent` can
   * resolve it. Grok uses this to materialize `AGENTS.md` when `systemPrompt`
   * is non-empty. Claude and codex return an empty array.
   */
  configFiles: InteractiveConfigFile[];
  /**
   * Final MCP server map after broker relaycast injection and persona overrides.
   * Consumers should use this for sanitized summaries instead of the raw argv.
   */
  mcpServers?: Record<string, McpServerSpec>;
}

/**
 * Relaycast wiring for a persona launched under an Agent Relay broker. When
 * present, {@link buildInteractiveSpec} injects a `relaycast` MCP server into
 * the harness's MCP config so the persona can message the team — the same
 * capability a non-persona broker spawn gets automatically.
 *
 * Personas otherwise can't reach relaycast: the broker wires its MCP by
 * recognizing the harness CLI it spawns, but a persona's PTY command is the
 * `agentworkforce` launcher (not the harness), and the claude branch emits
 * `--strict-mcp-config`, so a project `.mcp.json` is ignored. Injecting here —
 * into the same `--mcp-config` payload the harness already receives — is the
 * only path that survives strict mode. Callers populate this from the
 * `RELAY_*` env the broker sets on the launcher process (see
 * {@link buildRelaycastMcpServer}).
 */
export interface RelayMcpConfig {
  /** Relaycast API key (`RELAY_API_KEY`). */
  apiKey: string;
  /**
   * Broker-assigned worker name (`RELAY_AGENT_NAME`). Must match the name the
   * broker routes messages to, so the relaycast identity and the PTY worker
   * are the same agent. Registered strictly (`RELAY_STRICT_AGENT_NAME=1`).
   */
  agentName: string;
  /** Relaycast base URL (`RELAY_BASE_URL`); omitted ⇒ MCP server's default. */
  baseUrl?: string;
  /** Default workspace id/name (`RELAY_DEFAULT_WORKSPACE`). */
  defaultWorkspace?: string;
}

/**
 * Resolved config for the `ai-hist` MCP server. Both fields are optional —
 * the MCP defaults to its own discovery (`~/Projects/**​/.trajectories/**` for
 * the "why" and `~/.local/share/ai-hist/ai-history.db` for the "how") when the
 * caller supplies neither.
 */
export interface AiHistMcpConfig {
  /**
   * Root directory the MCP scans for per-run trajectory contract files
   * (`$TRAJECTORY_ROOT/**​/compacted/*.json`). Passed through as `TRAJECTORY_ROOT`.
   */
  trajectoryRoot?: string;
  /** Override the ai-hist SQLite DB path. Passed through as `AI_HIST_DB`. */
  dbPath?: string;
}

export interface BuildInteractiveSpecInput {
  harness: Harness;
  /**
   * Persona id — used as the opencode agent name. Claude, codex, and grok ignore
   * this field today; keeping it required here keeps call sites honest and
   * lets future harnesses consume it without another type change.
   */
  personaId: string;
  model: string;
  systemPrompt: string;
  /** Env-resolved MCP servers (pass the output of `resolveMcpServersLenient().servers`). */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * When set, a `relaycast` MCP server is merged into {@link mcpServers} so a
   * persona running under an Agent Relay broker can talk to the team. A
   * persona-declared server literally named `relaycast` takes precedence (it
   * is not overwritten). Wired for claude and codex; opencode/grok still warn
   * that MCP injection is unsupported.
   */
  relayMcp?: RelayMcpConfig;
  /**
   * When set, an `ai-hist` MCP server is merged into {@link mcpServers} so a
   * persona has retrieval access to its own decision trajectories (the "why")
   * and cross-tool prompt/session history (the "how"). A persona-declared
   * server literally named `ai-hist` takes precedence (it is not overwritten).
   * Callers resolve this from env + the persona's `memory.aiMemory` opt-in and
   * pass it explicitly — this function reads no environment itself. Wired for
   * claude and codex; opencode still warns that MCP injection is unsupported.
   */
  aiHist?: AiHistMcpConfig;
  permissions?: PersonaPermissions;
  harnessSettings?: HarnessSettings;
  /**
   * Absolute paths of directories to load as harness plugins for this
   * session (`--plugin-dir <path>` per entry where supported). Used to wire in out-of-repo
   * skill stages produced by
   * {@link SkillMaterializationOptions.installRoot}.
   * Currently supported by Claude and Grok. Codex/opencode emit a warning and
   * ignore the field.
   */
  pluginDirs?: readonly string[];
}

function stripProviderPrefix(model: string): string {
  const idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function hasAnyPermission(p: PersonaPermissions | undefined): boolean {
  if (!p) return false;
  return Boolean(p.allow?.length || p.deny?.length || p.mode);
}

function hasCodexLaunchSettings(settings: HarnessSettings | undefined): boolean {
  if (!settings) return false;
  return Boolean(
    settings.sandboxMode ||
      settings.approvalPolicy ||
      settings.workspaceWriteNetworkAccess !== undefined ||
      settings.webSearch ||
      settings.dangerouslyBypassApprovalsAndSandbox !== undefined
  );
}

const CODEX_ONLY_WARNING =
  'persona declares codex-only harnessSettings but the {harness} harness ignores sandboxMode, approvalPolicy, workspaceWriteNetworkAccess, webSearch, and dangerouslyBypassApprovalsAndSandbox.';


function toTomlBasicString(value: string): string {
  // JSON string escaping is compatible with TOML basic strings.
  return JSON.stringify(value);
}

function toTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => toTomlBasicString(value)).join(', ')}]`;
}

function toTomlInlineTable(entries: Record<string, string>): string {
  const pairs = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${toTomlBasicString(key)} = ${toTomlBasicString(value)}`);
  return `{ ${pairs.join(', ')} }`;
}

function pushCodexConfigArg(args: string[], key: string, tomlValue: string): void {
  args.push('--config', `${key}=${tomlValue}`);
}

function toTomlDottedKeySegment(key: string): string {
  // Bare keys are simpler/readable; quote only when TOML requires it.
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : toTomlBasicString(key);
}

function appendCodexMcpServerArgs(
  args: string[],
  mcpServers: Record<string, McpServerSpec>,
  warnings: string[]
): void {
  for (const [name, server] of Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
    const prefix = `mcp_servers.${toTomlDottedKeySegment(name)}`;
    if (server.type === 'stdio') {
      pushCodexConfigArg(args, `${prefix}.command`, toTomlBasicString(server.command));
      if (server.args && server.args.length > 0) {
        pushCodexConfigArg(args, `${prefix}.args`, toTomlStringArray(server.args));
      }
      if (server.env && Object.keys(server.env).length > 0) {
        pushCodexConfigArg(args, `${prefix}.env`, toTomlInlineTable(server.env));
      }
      continue;
    }

    if (server.type === 'sse') {
      warnings.push(
        `persona declares mcpServers.${name} with type 'sse'; codex expects streamable-http MCP endpoints. Passing url through as-is.`
      );
    }

    pushCodexConfigArg(args, `${prefix}.url`, toTomlBasicString(server.url));

    if (server.headers && Object.keys(server.headers).length > 0) {
      // Codex MCP uses `http_headers` for remote servers in config.toml.
      pushCodexConfigArg(args, `${prefix}.http_headers`, toTomlInlineTable(server.headers));
    }
  }
}


/**
 * Translate a persona's runtime fields into a concrete `{bin, args}` for
 * spawning an interactive harness session. Pure — no I/O, no side effects.
 *
 * The claude branch always emits `--mcp-config` + `--strict-mcp-config`
 * (with an empty `mcpServers: {}` payload if the persona declares none),
 * so the spawned session only sees the persona's declared MCP servers,
 * never the user's or project's Claude Code config.
 *
 * The codex branch carries the system prompt via `initialPrompt` because
 * codex has no dedicated system-prompt flag today — callers append it as
 * the final positional `[PROMPT]`.
 *
 * The grok branch launches the Grok Build CLI (`grok`) with the persona model.
 * Grok reads AGENTS.md and .grok/skills from the working tree; interactive
 * mode writes the persona system prompt into AGENTS.md when present, and
 * one-shot mode uses `--single` because Grok has no separate system-prompt flag.
 *
 * The opencode branch routes model + system prompt through opencode's
 * agent abstraction (see https://opencode.ai/config.json: `agent.<id>.{
 * model, prompt, mode }`). It emits an `opencode.json` via `configFiles`
 * for the caller to materialize at cwd, and selects it with `--agent
 * <personaId>`. It deliberately does NOT use `--prompt` (that flag
 * pre-fills the TUI input with a user message) or bare `-m` (opencode
 * expects full `provider/model` form and silently falls back to its
 * default when given a stripped model name). `initialPrompt` is `null`
 * so callers do not append a trailing positional, which opencode would
 * otherwise interpret as a project directory.
 *
 * The codex branch translates persona `mcpServers` into repeated
 * `--config mcp_servers.<name>...` TOML overrides so codex sessions receive
 * the same declared MCP servers as the persona.
 *
 * The opencode/grok branches emit a warning if the persona declares `mcpServers`.
 * Grok maps `permissions.mode: "bypassPermissions"` to `--always-approve`;
 * other permission fields warn.
 */
/**
 * Build the stdio MCP server spec for relaycast, mirroring the env block the
 * broker injects for a recognized harness (`npx -y @relaycast/mcp` + `RELAY_*`).
 * The agent token is intentionally omitted: the relaycast MCP auto-mints one
 * from `RELAY_API_KEY` + the strict agent name, which is the recommended path.
 */
function buildRelaycastMcpServer(relay: RelayMcpConfig): McpServerSpec {
  const env: Record<string, string> = {
    RELAY_API_KEY: relay.apiKey,
    RELAY_AGENT_NAME: relay.agentName,
    RELAY_AGENT_TYPE: 'agent',
    RELAY_STRICT_AGENT_NAME: '1'
  };
  if (relay.baseUrl) env.RELAY_BASE_URL = relay.baseUrl;
  if (relay.defaultWorkspace) env.RELAY_DEFAULT_WORKSPACE = relay.defaultWorkspace;
  return { type: 'stdio', command: 'npx', args: ['-y', '@relaycast/mcp'], env };
}

/** Outcome of resolving a persona's declared `relay` against the environment. */
export type ResolveRelayMcpResult =
  | { kind: 'disabled' }
  | { kind: 'missing-secret'; reason: string }
  | { kind: 'ready'; config: RelayMcpConfig };

/**
 * Resolve a persona's declarative {@link PersonaRelay} into a
 * {@link RelayMcpConfig} the launcher can hand to {@link buildInteractiveSpec}
 * as `relayMcp`. The persona declares **intent** (enabled, agentName, default
 * workspace); the secret (`RELAY_API_KEY`) and base URL come from `env`.
 *
 * Returns a discriminated result so callers can distinguish "off" from
 * "declared but the deploy env is missing `RELAY_API_KEY`" (worth a warning)
 * rather than silently dropping relay. Pure — reads only the passed `env`.
 */
export function resolvePersonaRelayMcp(
  relay: PersonaRelay | undefined,
  env: Record<string, string | undefined>,
  fallbackAgentName?: string
): ResolveRelayMcpResult {
  if (relay === undefined || relay === false) return { kind: 'disabled' };
  const cfg = typeof relay === 'object' ? relay : {};
  if (cfg.enabled === false) return { kind: 'disabled' };

  const apiKey = env.RELAY_API_KEY?.trim();
  const agentName = cfg.agentName?.trim() || env.RELAY_AGENT_NAME?.trim() || fallbackAgentName?.trim();
  if (!apiKey) {
    return { kind: 'missing-secret', reason: 'RELAY_API_KEY is not set in the deploy environment' };
  }
  if (!agentName) {
    return {
      kind: 'missing-secret',
      reason: 'no relay agent name (set relay.agentName, RELAY_AGENT_NAME, or pass the persona id)'
    };
  }
  const baseUrl = env.RELAY_BASE_URL?.trim();
  const defaultWorkspace = cfg.defaultWorkspace?.trim() || env.RELAY_DEFAULT_WORKSPACE?.trim();
  return {
    kind: 'ready',
    config: {
      apiKey,
      agentName,
      ...(baseUrl ? { baseUrl } : {}),
      ...(defaultWorkspace ? { defaultWorkspace } : {})
    }
  };
}

/**
 * Build the stdio MCP server spec for ai-hist — the unified retrieval surface
 * that serves both the "why" (this persona's compacted decision trajectories)
 * and the "how" (cross-tool prompt/session history). Launched via
 * `npx -y ai-hist-mcp` — the published, provenance-signed wrapper package that
 * re-exports the server from `ai-hist`. Env carries the trajectory root +
 * optional DB override.
 */
function buildAiHistMcpServer(cfg: AiHistMcpConfig): McpServerSpec {
  const env: Record<string, string> = {};
  if (cfg.trajectoryRoot) env.TRAJECTORY_ROOT = cfg.trajectoryRoot;
  if (cfg.dbPath) env.AI_HIST_DB = cfg.dbPath;
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'ai-hist-mcp'],
    env
  };
}

export function buildInteractiveSpec(input: BuildInteractiveSpecInput): InteractiveSpec {
  const {
    harness,
    personaId,
    model,
    systemPrompt,
    permissions,
    harnessSettings,
    pluginDirs
  } = input;
  // Merge the relaycast server into the persona's declared servers when running
  // under a broker. A persona-declared `relaycast` wins, so authors can still
  // override it. Kept pure: callers pass relayMcp explicitly (resolved from
  // env), so this function reads no environment itself.
  const personaMcpServers = input.mcpServers;
  const hasPersonaMcpServers =
    personaMcpServers !== undefined && Object.keys(personaMcpServers).length > 0;
  const relayMcpServer = input.relayMcp
    ? buildRelaycastMcpServer(input.relayMcp)
    : undefined;
  // ai-hist is injected only for personas that opt into recall
  // (callers gate `input.aiHist` on `memory.aiMemory`). A persona-declared
  // `ai-hist` server wins, same as relaycast.
  const aiHistServer = input.aiHist ? buildAiHistMcpServer(input.aiHist) : undefined;
  const injectsRelaycast = relayMcpServer !== undefined && personaMcpServers?.relaycast === undefined;
  const injectsAiHist = aiHistServer !== undefined && personaMcpServers?.['ai-hist'] === undefined;
  const mcpServers =
    injectsRelaycast || injectsAiHist
      ? {
          ...(injectsRelaycast ? { relaycast: relayMcpServer as McpServerSpec } : {}),
          ...(injectsAiHist ? { 'ai-hist': aiHistServer as McpServerSpec } : {}),
          ...(personaMcpServers ?? {})
        }
      : personaMcpServers;
  const warnings: string[] = [];
  const hasPluginDirs = pluginDirs !== undefined && pluginDirs.length > 0;

  switch (harness) {
    case 'claude': {
      const mcpPayload = JSON.stringify({ mcpServers: mcpServers ?? {} });
      // Skip --append-system-prompt entirely when the persona's prompt is
      // empty (e.g. an optional task-description input that wasn't
      // forwarded). Personas should keep systemPrompt sparse — the harness
      // already auto-loads CLAUDE.md / AGENTS.md from cwd, so the heavy
      // operating spec lives in the sidecar and the systemPrompt is only
      // worth setting when there's a concrete task to kick off with.
      const args: string[] = [
        '--model',
        model,
        ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
        '--mcp-config',
        mcpPayload,
        '--strict-mcp-config'
      ];
      if (hasPluginDirs) {
        for (const dir of pluginDirs!) {
          args.push('--plugin-dir', dir);
        }
      }
      if (permissions?.allow && permissions.allow.length > 0) {
        args.push('--allowedTools', ...permissions.allow);
      }
      if (permissions?.deny && permissions.deny.length > 0) {
        args.push('--disallowedTools', ...permissions.deny);
      }
      if (permissions?.mode) {
        args.push('--permission-mode', permissions.mode);
      }
      if (hasCodexLaunchSettings(harnessSettings)) {
        warnings.push(
          CODEX_ONLY_WARNING.replace('{harness}', 'claude')
        );
      }
      return { bin: 'claude', args, initialPrompt: null, warnings, configFiles: [], mcpServers };
    }
    case 'codex': {
      if (hasAnyPermission(permissions)) {
        warnings.push(
          'persona declares permissions but the codex harness is not yet wired for runtime permission injection; proceeding with codex defaults.'
        );
      }
      if (hasPluginDirs) {
        warnings.push(
          'pluginDirs is currently supported only for claude and grok; ignoring under the codex harness. Skills must be staged via codex conventions.'
        );
      }
      const args = ['-m', stripProviderPrefix(model)];
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        appendCodexMcpServerArgs(args, mcpServers, warnings);
      }
      if (harnessSettings?.approvalPolicy) {
        // `--ask-for-approval` was removed in codex 0.1.77+ (replaced by
        // `--sandbox` + `--dangerously-bypass-approvals-and-sandbox`).
        // Warn unconditionally — regardless of whether dangerouslyBypassApprovalsAndSandbox
        // is also set — so callers are alerted even when the bypass flag masks it.
        warnings.push(
          `codex harnessSettings.approvalPolicy ("${harnessSettings.approvalPolicy}") is not supported in codex 0.1.77+; ` +
            `the --ask-for-approval flag was removed. Use dangerouslyBypassApprovalsAndSandbox: true for non-interactive execution, ` +
            `or sandboxMode for filesystem access control.`
        );
      }
      if (harnessSettings?.dangerouslyBypassApprovalsAndSandbox) {
        // Single combined flag — collapses "no sandbox + never ask" and
        // suppresses codex's interactive "are you sure?" startup
        // confirmation. The two-flag form below still prompts.
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        if (harnessSettings?.sandboxMode) {
          args.push('--sandbox', harnessSettings.sandboxMode);
        }
        if (harnessSettings?.workspaceWriteNetworkAccess !== undefined) {
          args.push(
            '-c',
            `sandbox_workspace_write.network_access=${String(
              harnessSettings.workspaceWriteNetworkAccess
            )}`
          );
        }
      }
      if (harnessSettings?.webSearch) {
        args.push('--search');
      }
      return {
        bin: 'codex',
        args,
        initialPrompt: systemPrompt,
        warnings,
        configFiles: [],
        mcpServers
      };
    }
    case 'opencode': {
      const injectsDefaults = injectsRelaycast || injectsAiHist;
      const defaultNames = [
        ...(injectsRelaycast ? ['relaycast'] : []),
        ...(injectsAiHist ? ['ai-hist'] : [])
      ].join('/');
      if (hasPersonaMcpServers && injectsDefaults) {
        warnings.push(
          `persona declares mcpServers and default ${defaultNames} MCP injection was requested, but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.`
        );
      } else if (hasPersonaMcpServers) {
        warnings.push(
          'persona declares mcpServers but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      } else if (injectsDefaults) {
        warnings.push(
          `default ${defaultNames} MCP injection was requested but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.`
        );
      }
      if (hasAnyPermission(permissions)) {
        warnings.push(
          'persona declares permissions but the opencode harness is not yet wired for runtime permission injection; proceeding with opencode defaults.'
        );
      }
      if (hasPluginDirs) {
        warnings.push(
          'pluginDirs is currently supported only for claude and grok; ignoring under the opencode harness. Skills must be staged via opencode conventions.'
        );
      }
      if (hasCodexLaunchSettings(harnessSettings)) {
        warnings.push(
          CODEX_ONLY_WARNING.replace('{harness}', 'opencode')
        );
      }
      // opencode resolves a persona's system prompt + model through its own
      // "agent" abstraction (see https://opencode.ai/config.json: `agent.<id>.{
      // model, prompt, mode }`). Earlier revisions tried to use `--prompt` for
      // the system prompt and `-m` for the model directly, but that was wrong
      // on two counts:
      //   (a) `--prompt` pre-fills the TUI input buffer with a *user* message,
      //       not the agent's instructions — the persona's systemPrompt ended
      //       up sitting unsent in the chat field.
      //   (b) `-m` expects `provider/model` (opencode's own docs); stripping
      //       the `opencode/` prefix left just `gpt-5-nano`, which opencode
      //       could not resolve and silently fell back to its default model.
      // The correct shape is an `opencode.json` under cwd defining an agent
      // with the persona's prompt + full-provider-form model, selected via
      // `--agent <personaId>` at launch. We emit that file via configFiles
      // so the CLI can drop it into the mount dir before exec.
      // `permission: { '*': 'allow' }` is wildcard-allow across every
      // opencode tool (read / edit / bash / webfetch / etc.), matching the
      // built-in `build` agent's effective permissions. Without this,
      // opencode applies its restrictive default and agent-side edits never
      // reach the mount (the user-visible symptom: "I asked the agent to
      // change files and nothing synced"). The mount already sandboxes
      // writes so wildcard-allow does not escape to the real repo outside
      // of autosync, and callers who want a read-only persona (e.g. a code
      // reviewer) can override this in a follow-up PR that threads a
      // richer permission spec through the persona config — the current
      // PersonaPermissions shape is claude-specific and already warned about
      // for opencode.
      //
      // The bare-string form `permission: 'allow'` was valid in older
      // opencode versions but is rejected by 1.14.x: the agent decoder
      // runs `Object.assign({}, $.permission)` before the schema's own
      // string→`{'*': str}` normalizer fires, which spreads the string's
      // indexed chars and then fails validation against
      // `'ask' | 'allow' | 'deny'` ("Expected PermissionActionConfig, got
      // 'a' / 'l' / 'l' / 'o' / 'w'"). Emitting the object form directly
      // avoids that pre-decode step.
      // Omit `prompt` when the persona's systemPrompt is empty so opencode
      // falls back to the AGENTS.md that the harness auto-loads from cwd.
      // Personas should keep systemPrompt sparse — see the claude branch
      // above for the rationale.
      const agentConfig = {
        agent: {
          [personaId]: {
            model,
            ...(systemPrompt ? { prompt: systemPrompt } : {}),
            mode: 'primary',
            permission: { '*': 'allow' }
          }
        }
      };
      return {
        bin: 'opencode',
        args: ['--agent', personaId],
        initialPrompt: null,
        warnings,
        configFiles: [
          {
            path: 'opencode.json',
            contents: JSON.stringify(agentConfig, null, 2) + '\n'
          }
        ],
        mcpServers
      };
    }
    case 'grok': {
      if (hasPersonaMcpServers && injectsRelaycast) {
        warnings.push(
          'persona declares mcpServers and broker requested relaycast MCP injection, but the grok harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      } else if (hasPersonaMcpServers) {
        warnings.push(
          'persona declares mcpServers but the grok harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      } else if (injectsRelaycast) {
        warnings.push(
          'broker requested relaycast MCP injection but the grok harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      }
      if (permissions?.allow?.length || permissions?.deny?.length) {
        warnings.push(
          'persona declares permission allow/deny lists but the grok harness is not wired for allow/deny injection; proceeding without allow/deny rules.'
        );
      }
      const args = ['--no-auto-update', '--model', model];
      if (permissions?.mode === 'bypassPermissions') {
        args.push('--always-approve');
      } else if (permissions?.mode && permissions.mode !== 'default') {
        warnings.push(
          `persona declares permissions.mode "${permissions.mode}" but the grok harness only supports bypassPermissions via --always-approve; proceeding with Grok defaults.`
        );
      }
      if (hasPluginDirs) {
        for (const dir of pluginDirs!) {
          args.push('--plugin-dir', dir);
        }
      }
      if (
        harnessSettings?.dangerouslyBypassApprovalsAndSandbox &&
        !args.includes('--always-approve')
      ) {
        args.push('--always-approve');
      }
      if (harnessSettings?.sandboxMode) {
        warnings.push('grok harnessSettings.sandboxMode is not yet wired; proceeding with Grok defaults.');
      }
      if (harnessSettings?.approvalPolicy) {
        warnings.push(
          'grok harnessSettings.approvalPolicy is not supported; use permissions.mode "bypassPermissions" or dangerouslyBypassApprovalsAndSandbox for --always-approve.'
        );
      }
      if (harnessSettings?.workspaceWriteNetworkAccess !== undefined) {
        warnings.push('grok harnessSettings.workspaceWriteNetworkAccess is not yet wired; proceeding with Grok defaults.');
      }
      if (harnessSettings?.webSearch) {
        warnings.push('grok harnessSettings.webSearch is not wired to a Grok CLI flag; proceeding with Grok defaults.');
      }
      return {
        bin: 'grok',
        args,
        initialPrompt: null,
        warnings,
        configFiles: systemPrompt
          ? [
              {
                path: 'AGENTS.md',
                contents: systemPrompt.endsWith('\n') ? systemPrompt : `${systemPrompt}\n`
              }
            ]
          : [],
        mcpServers
      };
    }
    default: {
      // Exhaustiveness guard: if `Harness` gains a new variant, this
      // assertion will fail to compile and force the maintainer to handle
      // the new case above rather than silently dropping into an untyped
      // fallthrough at runtime.
      const _exhaustive: never = harness;
      throw new Error(`Unhandled harness: ${String(_exhaustive)}`);
    }
  }
}

/** Result of translating a persona's runtime into a one-shot, non-interactive
 * spawnable command. Caller writes `configFiles` before spawning. */
export interface NonInteractiveSpec {
  bin: string;
  args: readonly string[];
  configFiles: readonly InteractiveConfigFile[];
  warnings: readonly string[];
}

/**
 * Translate a persona's runtime into a non-interactive, one-shot command.
 * Layers harness-specific non-interactive flags on top of {@link buildInteractiveSpec},
 * then appends the user task. Pure — no I/O.
 *
 * - `claude`: appends `--print --output-format text <task>`.
 * - `codex`:  prefixes `exec`, appends `--skip-git-repo-check`, then a prompt
 *   built from any `initialPrompt` joined with the user task.
 * - `opencode`: prefixes `run`, appends `--model <m> --format default
 *   [--dir <cwd>] [--title <n>] <task>`.
 * - `grok`: appends `--output-format plain [--cwd <cwd>] --always-approve
 *   --single <prompt>`, where prompt includes the persona system prompt plus
 *   the one-shot task.
 */
export function buildNonInteractiveSpec(
  input: BuildInteractiveSpecInput & {
    task: string;
    name?: string;
    workingDirectory?: string;
  }
): NonInteractiveSpec {
  const interactive = buildInteractiveSpec(input);
  switch (input.harness) {
    case 'claude': {
      const args = [...interactive.args, '--print', '--output-format', 'text'];
      args.push(input.task);
      return {
        bin: interactive.bin,
        args,
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    case 'codex': {
      const prompt = interactive.initialPrompt
        ? `${interactive.initialPrompt}\n\nUser task:\n${input.task}`
        : input.task;
      return {
        bin: interactive.bin,
        args: ['exec', ...interactive.args, '--skip-git-repo-check', prompt],
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    case 'opencode': {
      const args = ['run', ...interactive.args, '--model', input.model, '--format', 'default'];
      if (input.workingDirectory) args.push('--dir', input.workingDirectory);
      if (input.name) args.push('--title', input.name);
      args.push(input.task);
      return {
        bin: interactive.bin,
        args,
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    case 'grok': {
      const prompt = input.systemPrompt
        ? `${input.systemPrompt}\n\nUser task:\n${input.task}`
        : input.task;
      const args = [...interactive.args, '--output-format', 'plain'];
      if (input.workingDirectory) args.push('--cwd', input.workingDirectory);
      if (!args.includes('--always-approve')) {
        args.push('--always-approve');
      }
      args.push('--single', prompt);
      return {
        bin: interactive.bin,
        args,
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    default: {
      const _exhaustive: never = input.harness;
      throw new Error(`Unhandled harness: ${String(_exhaustive)}`);
    }
  }
}
