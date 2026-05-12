import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { bundleStager } from './bundle.js';
import {
  connectIntegrations,
  envIntegrationResolver,
  type IntegrationConnectResolver,
  type ProviderSubscriptionResolver
} from './connect.js';
import { createTerminalIO } from './io.js';
import { envWorkspaceAuth, type WorkspaceAuth } from './login.js';
import { devLauncher } from './modes/dev.js';
import { sandboxLauncher } from './modes/sandbox.js';
import { cloudLauncher } from './modes/cloud.js';
import { preflightPersona } from './preflight.js';
import type {
  BundleStager,
  DeployMode,
  DeployOptions,
  DeployResult,
  ModeLauncher
} from './types.js';

/**
 * External-resolver bundle the orchestrator depends on. Each field has a
 * real default backed by env (or, for `bundle`/`modes`, the real
 * launchers). Callers override individual fields to plug in higher-level
 * implementations: a CLI dispatch case may pass an `IntegrationResolver`
 * backed by `@relayfile/sdk`'s OAuth flow once it is available, tests
 * pass deterministic in-memory fakes.
 */
export interface DeployResolvers {
  workspaceAuth?: WorkspaceAuth;
  integrations?: IntegrationConnectResolver;
  subscription?: ProviderSubscriptionResolver;
  bundle?: BundleStager;
  modes?: Partial<Record<DeployMode, ModeLauncher>>;
}

/**
 * Pick the run mode for this deploy. Per the deploy-v1 spec:
 *   - Explicit `--mode` always wins.
 *   - Otherwise `--mode sandbox` is the default when Daytona creds resolve
 *     (BYO env or workforce-managed both count as "resolved" here; the
 *     sandbox launcher itself decides which auth path to use).
 *   - Otherwise fall back to `--mode dev`.
 *
 * The orchestrator doesn't probe the cloud endpoint here — `--mode cloud`
 * stays opt-in until the M4 endpoint is live.
 */
export function pickMode(opts: DeployOptions): DeployMode {
  if (opts.mode) return opts.mode;
  // Daytona credential probe: BYO env var, or assume workforce-managed via
  // the active workspace (the sandbox launcher gates on its own auth).
  if (process.env.DAYTONA_API_KEY || process.env.WORKFORCE_WORKSPACE_TOKEN) {
    return 'sandbox';
  }
  return 'dev';
}

/**
 * Top-level entry. The CLI dispatch case calls this with parsed options
 * and resolvers. Returns a `DeployResult` summarizing the deploy; on
 * failure, throws with an actionable message (no half-deploys).
 *
 * Step ordering — see `docs/plans/deploy-v1.md` §5:
 *   1. Preflight persona (parse, lint, onEvent on disk).
 *   2. Resolve workspace + token.
 *   3. Connect integrations (prompt per provider).
 *   4. Stage bundle to `.workforce/build/<id>/`.
 *   5. Launch in the resolved mode.
 *   6. Return the handle + summary.
 *
 * `dryRun: true` exits cleanly after step 1, returning a minimal result
 * with the warnings collected so far.
 *
 * `bundleOut: <dir>` runs steps 1-4 then exits, skipping launch.
 */
export async function deploy(opts: DeployOptions, resolvers: DeployResolvers = {}): Promise<DeployResult> {
  const io = opts.io ?? createTerminalIO();
  const warnings: string[] = [];

  io.info(`workforce deploy → ${opts.personaPath}`);

  const preflight = await preflightPersona(opts.personaPath);
  warnings.push(...preflight.warnings);
  for (const w of preflight.warnings) io.warn(w);

  io.info(
    `persona ${preflight.persona.id}: ${preflight.integrations.length} integration(s), ${preflight.schedules.length} schedule(s)`
  );

  if (opts.dryRun) {
    io.info('--dry-run: persona validated; exiting before any side effects');
    return {
      deploymentId: preflight.persona.id,
      mode: opts.mode ?? pickMode(opts),
      workspace: opts.workspace ?? '(dry-run)',
      bundleDir: '(dry-run)',
      connectedIntegrations: [],
      schedules: preflight.schedules,
      warnings
    };
  }

  // `--bundle-out` produces a workspace-agnostic artifact, so skip the
  // workspace/integration handshakes entirely. Anyone bundling for CI
  // or inspection shouldn't need credentials they don't yet have.
  if (opts.bundleOut) {
    const bundleDir = path.resolve(opts.bundleOut);
    await mkdir(bundleDir, { recursive: true });
    const stager = resolvers.bundle ?? bundleStager;
    const bundle = await stager.stage({
      personaPath: preflight.personaPath,
      persona: preflight.persona,
      outDir: bundleDir
    });
    io.info(`bundle: staged to ${bundle.runnerPath} (${formatBytes(bundle.sizeBytes)})`);
    io.info(`--bundle-out: bundle ready at ${bundleDir}; skipping launch`);
    return {
      deploymentId: preflight.persona.id,
      mode: opts.mode ?? pickMode(opts),
      workspace: opts.workspace ?? '(bundle-only)',
      bundleDir,
      connectedIntegrations: [],
      schedules: preflight.schedules,
      warnings
    };
  }

  const workspaceAuth = resolvers.workspaceAuth ?? envWorkspaceAuth();
  const { workspace } = await workspaceAuth.resolveWorkspace({
    override: opts.workspace,
    io
  });
  io.info(`workspace: ${workspace}`);

  const connectResult = await connectIntegrations({
    persona: preflight.persona,
    workspace,
    noConnect: opts.noConnect === true,
    io,
    integrations: resolvers.integrations ?? envIntegrationResolver(),
    ...(resolvers.subscription ? { subscription: resolvers.subscription } : {})
  });
  const failed = connectResult.outcomes.filter((o) => o.status === 'failed');
  if (failed.length > 0) {
    throw new Error(
      `deploy aborted: ${failed.length} integration(s) failed to connect: ${failed.map((f) => f.provider).join(', ')}`
    );
  }
  const skipped = connectResult.outcomes.filter((o) => o.status === 'skipped');
  if (skipped.length > 0) {
    throw new Error(
      `deploy aborted: ${skipped.length} integration(s) skipped: ${skipped.map((s) => s.provider).join(', ')}`
    );
  }
  const connectedIntegrations = connectResult.outcomes
    .filter((o) => o.status === 'already-connected' || o.status === 'connected-now')
    .map((o) => o.provider);

  const bundleDir = path.resolve(
    path.join(preflight.personaDir, '.workforce', 'build', preflight.persona.id)
  );
  await mkdir(bundleDir, { recursive: true });
  const stager = resolvers.bundle ?? bundleStager;
  const bundle = await stager.stage({
    personaPath: preflight.personaPath,
    persona: preflight.persona,
    outDir: bundleDir
  });
  io.info(`bundle: staged to ${bundle.runnerPath} (${formatBytes(bundle.sizeBytes)})`);

  const mode: DeployMode = opts.mode ?? pickMode(opts);
  io.info(`mode: ${mode}`);
  const launcher = resolveLauncher(mode, resolvers);
  const handle = await launcher.launch({
    persona: preflight.persona,
    bundle,
    workspace,
    io,
    ...(opts.detach ? { detach: true } : {})
  });
  io.info(`launched: ${mode}/${handle.id}`);

  return {
    deploymentId: preflight.persona.id,
    mode,
    workspace,
    bundleDir,
    connectedIntegrations,
    schedules: preflight.schedules,
    runHandle: handle,
    warnings
  };
}

function resolveLauncher(mode: DeployMode, resolvers: DeployResolvers): ModeLauncher {
  const supplied = resolvers.modes?.[mode];
  if (supplied) return supplied;
  switch (mode) {
    case 'dev':
      return devLauncher;
    case 'sandbox':
      return sandboxLauncher;
    case 'cloud':
      return cloudLauncher;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
