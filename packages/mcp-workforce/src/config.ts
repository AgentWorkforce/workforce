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
  /** Per-provider direct tokens — same env convention deploy uses. */
  providerTokens: Record<string, string>;
}

const PROVIDER_TOKEN_PREFIX = 'WORKFORCE_INTEGRATION_';
const PROVIDER_TOKEN_SUFFIX = '_TOKEN';

const DEFAULT_CLOUD_URL = 'https://cloud.agentworkforce.com';

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

  const providerTokens: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(PROVIDER_TOKEN_PREFIX) || !key.endsWith(PROVIDER_TOKEN_SUFFIX)) continue;
    const provider = key
      .slice(PROVIDER_TOKEN_PREFIX.length, key.length - PROVIDER_TOKEN_SUFFIX.length)
      .toLowerCase();
    const value = (raw ?? '').trim();
    if (provider && value) providerTokens[provider] = value;
  }

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
    providerTokens
  };
}
