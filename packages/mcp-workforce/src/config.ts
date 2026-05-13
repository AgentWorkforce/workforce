/**
 * Resolved configuration for a running MCP-workforce server. The runtime
 * sets these env vars when it spawns the harness via `ctx.harness.run`;
 * a stand-alone `npx @agentworkforce/mcp-workforce` invocation reads
 * them from the user's shell.
 */
export interface WorkforceMcpConfig {
  /** Workspace this server is bound to. Required. */
  workspaceId: string;
  /** Persona id the harness is currently running under. Optional. */
  personaId?: string;
  /** Workspace-scoped token used for workflow + cloud API calls. */
  runtimeToken?: string;
  /** Workforce cloud base URL. */
  cloudUrl: string;
  /** Supermemory API key (memory tools). */
  supermemoryApiKey?: string;
  /** Supermemory endpoint override. */
  supermemoryEndpoint?: string;
  /**
   * Relayfile mount root. Integration clients read/write canonical
   * JSON files under this path; Relayfile's writeback worker turns
   * those file operations into the real provider API calls. Required
   * for any `integration.*` tool to function.
   */
  relayfileMountRoot?: string;
  /**
   * Default writeback timeout for integration calls that block on a
   * receipt (createIssue, comment, etc.). Defaults to 30s; the
   * runtime overrides this via `WORKFORCE_WRITEBACK_TIMEOUT_MS` when
   * a persona configures it.
   */
  writebackTimeoutMs: number;
}

const DEFAULT_CLOUD_URL = 'https://cloud.agentworkforce.com';
const DEFAULT_WRITEBACK_TIMEOUT_MS = 30_000;

/**
 * Build the config from a snapshot of the env. `loadConfig()` reads from
 * `process.env` by default; tests pass a fixture object. Returns an
 * object with the workspaceId guaranteed; everything else is optional and
 * tool implementations check at call time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkforceMcpConfig {
  const workspaceId = (env.WORKFORCE_WORKSPACE_ID ?? '').trim();
  if (!workspaceId) {
    throw new Error(
      'WORKFORCE_WORKSPACE_ID is required to start the workforce MCP server. The workforce runtime sets this automatically when spawning the harness; if you are running the server stand-alone, export it before invoking workforce-mcp.'
    );
  }

  const writebackRaw = (env.WORKFORCE_WRITEBACK_TIMEOUT_MS ?? '').trim();
  const writebackTimeoutMs = writebackRaw
    ? Math.max(0, Number.parseInt(writebackRaw, 10) || DEFAULT_WRITEBACK_TIMEOUT_MS)
    : DEFAULT_WRITEBACK_TIMEOUT_MS;

  return {
    workspaceId,
    ...(env.WORKFORCE_PERSONA_ID?.trim() ? { personaId: env.WORKFORCE_PERSONA_ID.trim() } : {}),
    ...(env.WORKFORCE_RUNTIME_TOKEN?.trim()
      ? { runtimeToken: env.WORKFORCE_RUNTIME_TOKEN.trim() }
      : {}),
    cloudUrl: (env.WORKFORCE_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL).replace(/\/$/, ''),
    ...(env.SUPERMEMORY_API_KEY?.trim()
      ? { supermemoryApiKey: env.SUPERMEMORY_API_KEY.trim() }
      : {}),
    ...(env.SUPERMEMORY_ENDPOINT?.trim()
      ? { supermemoryEndpoint: env.SUPERMEMORY_ENDPOINT.trim() }
      : {}),
    ...(env.RELAYFILE_MOUNT_ROOT?.trim()
      ? { relayfileMountRoot: env.RELAYFILE_MOUNT_ROOT.trim() }
      : env.RELAYFILE_ROOT?.trim()
        ? { relayfileMountRoot: env.RELAYFILE_ROOT.trim() }
        : {}),
    writebackTimeoutMs
  };
}
