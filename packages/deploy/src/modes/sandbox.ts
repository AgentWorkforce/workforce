import type {
  ModeLaunchInput,
  ModeLaunchHandle,
  ModeLauncher
} from '../types.js';
import { runtimeContextEnv } from '../runtime-context.js';
import {
  SANDBOX_BUNDLE_DIR,
  createByoSandboxClient,
  createProxySandboxClient,
  type SandboxClient,
  type SandboxHandle
} from './sandbox-client.js';

const DEFAULT_CLOUD_URL = 'https://cloud.agentworkforce.com';

/**
 * Daytona-backed sandbox launcher with two auth paths:
 *
 *   - **BYO** — `DAYTONA_API_KEY` (or `DAYTONA_JWT_TOKEN` +
 *     `DAYTONA_ORGANIZATION_ID`) is present in env. The launcher talks
 *     directly to Daytona via `@daytonaio/sdk`. Zero workforce-cloud
 *     round-trips; useful in CI or for power users with their own
 *     Daytona accounts.
 *   - **Workforce-managed** — `DAYTONA_API_KEY` is absent but
 *     `WORKFORCE_WORKSPACE_TOKEN` is set (either via `workforce login`
 *     or exported manually). The launcher POSTs the cloud sandboxes
 *     endpoint to mint a proxy handle and routes all exec/upload
 *     traffic through cloud's per-sandbox `/exec` and `/files` URLs.
 *     Cloud holds the org Daytona credentials so users never see them.
 *
 * Mode picking is purely env-based today. Pass `--byo-sandbox` on the
 * deploy CLI to force BYO when both are configured (handled in
 * `resolveLauncher`, not here).
 *
 * Streaming: cloud's `/exec` endpoint and Daytona's `executeCommand` are
 * both final-result-only. The runner exits when its envelope stream
 * ends, and the resulting output is forwarded to DeployIO at that
 * point. Live tail support is gated on a future iteration.
 */
export const sandboxLauncher: ModeLauncher = {
  async launch(input: ModeLaunchInput): Promise<ModeLaunchHandle> {
    const client = resolveSandboxClient(input, input.byoSandbox ? { forceByo: true } : {});
    const handle = await client.mint({
      label: `wf-${input.persona.id}`,
      env: {
        ...(input.env ?? {}),
        ...runtimeContextEnv(input.persona, input.env),
        WORKFORCE_WORKSPACE_ID: input.workspace,
        WORKFORCE_PERSONA_ID: input.persona.id
      }
    });

    try {
      await client.uploadBundle(handle, input.bundle);
    } catch (err) {
      // If upload fails the sandbox is unrecoverable for this deploy.
      // Tear it down so we don't leak Daytona resources or charge for
      // an idle workforce-managed sandbox.
      await client.destroy(handle).catch(() => undefined);
      throw err;
    }

    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      try {
        await client.destroy(handle);
      } catch (err) {
        input.io.warn(
          `sandbox: cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    const done = (async () => {
      try {
        const result = await client.exec(handle, 'node runner.mjs', {
          cwd: SANDBOX_BUNDLE_DIR
        });
        const output = result.output.trim();
        if (output.length > 0) input.io.info(`[sandbox] ${output}`);
        return { code: result.exitCode };
      } catch (err) {
        if (!stopping) {
          input.io.error(
            `sandbox: runner exec failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { code: 1 };
      }
    })();

    return {
      id: handle.id,
      stop,
      done
    };
  }
};

/**
 * Pick the sandbox client implementation based on env. Public so the
 * deploy orchestrator (and tests) can plug in an explicit choice.
 */
export function resolveSandboxClient(
  input: Pick<ModeLaunchInput, 'workspace' | 'persona' | 'env'> & Partial<Pick<ModeLaunchInput, 'io'>>,
  overrides: {
    /** Force BYO even when both BYO and workforce-managed are configured. */
    forceByo?: boolean;
    /** Inject a custom client (tests). */
    client?: SandboxClient;
  } = {}
): SandboxClient {
  if (overrides.client) return overrides.client;

  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  const jwtToken = process.env.DAYTONA_JWT_TOKEN?.trim();
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID?.trim();
  const byoAvailable = Boolean(apiKey || jwtToken);

  if (overrides.forceByo || byoAvailable) {
    if (!byoAvailable) {
      throw new Error(
        'sandbox launcher: --byo-sandbox requested but no Daytona credentials are in env. Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID).'
      );
    }
    return createByoSandboxClient({
      ...(apiKey ? { apiKey } : {}),
      ...(jwtToken ? { jwtToken } : {}),
      ...(organizationId ? { organizationId } : {})
    });
  }

  const workspaceToken = process.env.WORKFORCE_WORKSPACE_TOKEN?.trim();
  if (!workspaceToken) {
    throw new Error(
      'sandbox launcher: no Daytona credentials and no workforce workspace token. Either export DAYTONA_API_KEY, or run `workforce login` (sets WORKFORCE_WORKSPACE_TOKEN) so we can mint a workforce-managed sandbox.'
    );
  }
  const cloudUrl = (process.env.WORKFORCE_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL).replace(/\/$/, '');
  return createProxySandboxClient({
    cloudUrl,
    workspaceId: input.workspace,
    workspaceToken,
    personaId: input.persona.id
  });
}

// Re-exported for tests + power users wanting to compose the client manually.
export {
  SANDBOX_BUNDLE_DIR,
  createByoSandboxClient,
  createProxySandboxClient,
  type SandboxClient,
  type SandboxHandle
} from './sandbox-client.js';

/**
 * Legacy alias for the env-resolved Daytona credentials surface. Kept so
 * existing imports of `resolveSandboxAuth` continue to compile; new code
 * should use `resolveSandboxClient` instead.
 */
export interface SandboxAuth {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

export function resolveSandboxAuth(): SandboxAuth | undefined {
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  const jwtToken = process.env.DAYTONA_JWT_TOKEN?.trim();
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID?.trim();
  if (!apiKey && !jwtToken) return undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(jwtToken ? { jwtToken } : {}),
    ...(organizationId ? { organizationId } : {})
  };
}
