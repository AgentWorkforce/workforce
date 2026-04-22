import type {
  Harness,
  McpServerSpec,
  PersonaPermissions
} from '@agentworkforce/workload-router';

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
  /** Binary to exec (e.g. `claude`, `codex`, `opencode`). */
  bin: string;
  /** Argv for the binary, in order. Callers should `spawn(bin, args)`. */
  args: readonly string[];
  /**
   * If set, the caller should append this as the final positional argument
   * — used by harnesses that don't support a separate system-prompt flag
   * to carry the persona's system prompt as the initial user prompt.
   * Currently only codex takes this path; claude uses `--append-system-prompt`
   * and opencode writes the prompt into `opencode.json` (see `configFiles`),
   * so both return `null` here.
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
   * resolve it; claude and codex return an empty array.
   */
  configFiles: InteractiveConfigFile[];
}

export interface BuildInteractiveSpecInput {
  harness: Harness;
  /**
   * Persona id — used as the opencode agent name. Claude and codex ignore
   * this field today; keeping it required here keeps call sites honest and
   * lets future harnesses consume it without another type change.
   */
  personaId: string;
  model: string;
  systemPrompt: string;
  /** Env-resolved MCP servers (pass the output of `resolveMcpServersLenient().servers`). */
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
  /**
   * Absolute paths of directories to load as Claude Code plugins for this
   * session (`--plugin-dir <path>` per entry). Used to wire in out-of-repo
   * skill stages produced by
   * {@link import('@agentworkforce/workload-router').SkillMaterializationOptions.installRoot}.
   * Claude-only: other harnesses emit a warning and ignore the field.
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
 * The opencode branch uses opencode's own `--prompt` flag (wired directly
 * into `args`) and returns `initialPrompt: null`. The earlier behavior of
 * appending the prompt as a trailing positional was unsafe: `opencode`'s
 * bare form treats a trailing positional as a project directory, which
 * caused the TUI to fail with "Failed to change directory to …".
 *
 * Both codex and opencode emit a warning if the persona declares
 * `mcpServers` or `permissions` — those features aren't wired for those
 * harnesses yet.
 */
export function buildInteractiveSpec(input: BuildInteractiveSpecInput): InteractiveSpec {
  const { harness, personaId, model, systemPrompt, mcpServers, permissions, pluginDirs } = input;
  const warnings: string[] = [];
  const hasPluginDirs = pluginDirs !== undefined && pluginDirs.length > 0;

  switch (harness) {
    case 'claude': {
      const mcpPayload = JSON.stringify({ mcpServers: mcpServers ?? {} });
      const args: string[] = [
        '--model',
        model,
        '--append-system-prompt',
        systemPrompt,
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
      return { bin: 'claude', args, initialPrompt: null, warnings, configFiles: [] };
    }
    case 'codex': {
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        warnings.push(
          'persona declares mcpServers but the codex harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      }
      if (hasAnyPermission(permissions)) {
        warnings.push(
          'persona declares permissions but the codex harness is not yet wired for runtime permission injection; proceeding with codex defaults.'
        );
      }
      if (hasPluginDirs) {
        warnings.push(
          'pluginDirs is currently claude-only; ignoring under the codex harness. Skills must be staged via codex conventions.'
        );
      }
      return {
        bin: 'codex',
        args: ['-m', stripProviderPrefix(model)],
        initialPrompt: systemPrompt,
        warnings,
        configFiles: []
      };
    }
    case 'opencode': {
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        warnings.push(
          'persona declares mcpServers but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.'
        );
      }
      if (hasAnyPermission(permissions)) {
        warnings.push(
          'persona declares permissions but the opencode harness is not yet wired for runtime permission injection; proceeding with opencode defaults.'
        );
      }
      if (hasPluginDirs) {
        warnings.push(
          'pluginDirs is currently claude-only; ignoring under the opencode harness. Skills must be staged via opencode conventions.'
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
      const agentConfig = {
        agent: {
          [personaId]: {
            model,
            prompt: systemPrompt,
            mode: 'primary'
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
        ]
      };
    }
  }
}
