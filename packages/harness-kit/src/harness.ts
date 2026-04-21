import type {
  Harness,
  McpServerSpec,
  PersonaPermissions
} from '@agentworkforce/workload-router';

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
   * Currently only codex takes this path; opencode uses its own `--prompt`
   * flag (wired directly into `args`) and claude uses `--append-system-prompt`,
   * so both return `null` here.
   */
  initialPrompt: string | null;
  /**
   * Non-fatal warnings produced during translation — e.g. "codex doesn't
   * support MCP yet, ignoring". Callers decide whether to print them.
   */
  warnings: string[];
}

export interface BuildInteractiveSpecInput {
  harness: Harness;
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
  const { harness, model, systemPrompt, mcpServers, permissions, pluginDirs } = input;
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
      return { bin: 'claude', args, initialPrompt: null, warnings };
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
        warnings
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
      // opencode's bare form is `opencode [project]` where the trailing
      // positional is a project directory, NOT a prompt. Carry the persona's
      // system prompt via `--prompt` (top-level TUI flag) so it isn't parsed
      // as a cwd.
      return {
        bin: 'opencode',
        args: ['--model', stripProviderPrefix(model), '--prompt', systemPrompt],
        initialPrompt: null,
        warnings
      };
    }
  }
}
