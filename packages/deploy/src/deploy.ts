import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { defaultApiUrl } from '@agent-relay/cloud';
import type {
  AgentSpec,
  IntegrationSource,
  PersonaIntegrationTrigger,
  PersonaSpec
} from '@agentworkforce/persona-kit';
import { bundleStager } from './bundle.js';
import { resolveCloudUrl } from './cloud-url.js';
import {
  collectPickerInputs,
  connectIntegrations,
  envIntegrationResolver,
  relayfileCatalogConfigKeyResolver,
  relayfileIntegrationResolver,
  relayfileOptionsResolver,
  type ConnectAllInput,
  type IntegrationAuthRecoveryResolver,
  type IntegrationConnectResolver,
  type IntegrationOptionsResolver,
  type ProviderConfigKeyResolver,
  type ProviderSubscriptionResolver
} from './connect.js';
import { createTerminalIO } from './io.js';
import {
  readActiveWorkspace,
  resolveWorkspaceToken,
  type WorkspaceAuth
} from './login.js';
import { devLauncher } from './modes/dev.js';
import { sandboxLauncher } from './modes/sandbox.js';
import {
  cloudLauncher,
  ensureCloudSubscriptionReady,
  validateCloudSubscriptionSupport
} from './modes/cloud/index.js';
import { preflightPersona } from './preflight.js';
import type {
  BundleStager,
  DeployIO,
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
  authRecovery?: CloudAuthRecoveryResolver;
  subscription?: ProviderSubscriptionResolver;
  providerConfigKeys?: ProviderConfigKeyResolver;
  /**
   * Resolves candidate lists for picker-annotated inputs. Defaults to a
   * cloud-backed resolver in `cloud` mode; supply your own (or a fake) to
   * drive the onboarding pickers in tests or non-cloud flows.
   */
  integrationOptions?: IntegrationOptionsResolver;
  bundle?: BundleStager;
  modes?: Partial<Record<DeployMode, ModeLauncher>>;
}

export interface CloudAuthRecoveryResolver {
  recover(args: {
    workspace: string;
    cloudUrl: string;
    io: DeployIO;
    provider: string;
    reason: string;
  }): Promise<{ token: string } | false | null | undefined>;
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
  const mode: DeployMode = opts.mode ?? pickMode(opts);
  warnings.push(...preflight.warnings);
  for (const w of preflight.warnings) io.warn(w);

  io.info(
    `persona ${preflight.persona.id}: ${preflight.integrations.length} integration(s), ${preflight.schedules.length} schedule(s)`
  );

  validateSubscriptionSupport(preflight.persona, {
    mode,
    subscription: resolvers.subscription,
    ...(opts.harnessSource ? { harnessSource: opts.harnessSource } : {})
  });

  if (opts.dryRun) {
    io.info('--dry-run: persona validated; exiting before any side effects');
    return {
      deploymentId: preflight.persona.id,
      mode,
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
      mode,
      workspace: opts.workspace ?? '(bundle-only)',
      bundleDir,
      connectedIntegrations: [],
      schedules: preflight.schedules,
      warnings
    };
  }

  const active = await readActiveWorkspace().catch(() => null);
  const cloudUrl = resolveCloudUrl({
    ...(opts.cloudUrl ? { flag: opts.cloudUrl } : {}),
    active
  });

  // Auth resolution: an explicit `resolvers.workspaceAuth` (used by tests
  // and bespoke harnesses) wins. Otherwise consult the shared resolver
  // that walks env → cloud-auth.json → active.json → legacy keychain,
  // which is the same path `list`/`destroy` and the cloud launcher use.
  // The orchestrator historically called `envWorkspaceAuth()` directly,
  // which only honoured WORKFORCE_WORKSPACE_TOKEN + a long-dead keychain —
  // a user who freshly ran `agentworkforce login` would hit "no workspace
  // resolved" because that flow only writes the shared accessToken and
  // active.json pointer.
  const resolvedAuth = resolvers.workspaceAuth
    ? await resolvers.workspaceAuth.resolveWorkspace({ override: opts.workspace, io })
    : await resolveWorkspaceToken({
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
        cloudUrl,
        io,
        ...(opts.noPrompt ? { noPrompt: true } : {})
      });
  const workspace = (resolvedAuth.workspace ?? opts.workspace ?? '').trim();
  if (!workspace) {
    throw new Error(
      'workspace is required for deploy: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `agentworkforce login`'
    );
  }
  io.info(`workspace: ${workspace}`);
  let activeToken = (resolvedAuth.token ?? '').trim();
  if (!activeToken) {
    throw new Error('workspace token is required for deploy: run `agentworkforce login` or set WORKFORCE_WORKSPACE_TOKEN');
  }
  let subscription = resolvers.subscription;
  let credentialSelections: Record<string, string> | undefined;
  const providerConfigKeys = resolvers.providerConfigKeys
    ?? (mode === 'cloud'
      ? relayfileCatalogConfigKeyResolver({
          apiUrl: normalizeCloudUrl(cloudUrl ?? defaultApiUrl()),
          workspaceToken: () => activeToken,
          io
        })
      : undefined);

  if (preflight.persona.useSubscription && !subscription) {
    const result = await ensureCloudSubscriptionReady({
      cloudUrl: normalizeCloudUrl(cloudUrl ?? defaultApiUrl()),
      workspaceId: workspace,
      token: activeToken,
      persona: preflight.persona,
      io,
      noPrompt: opts.noPrompt === true || opts.noConnect === true,
      ...(opts.harnessSource ? { harnessSource: opts.harnessSource } : {}),
      ...(opts.byokKey ? { byokKey: opts.byokKey } : {})
    });
    credentialSelections = result.credentialSelections;
    subscription = alreadyConnectedSubscriptionResolver(result.provider);
  }

  const connectedIntegrations = await connectAndCollectIntegrations({
    persona: preflight.persona,
    workspace,
    noConnect: opts.noConnect === true,
    ...(opts.noPrompt ? { noPrompt: true } : {}),
    ...(opts.reconnectProviders ? { reconnectProviders: opts.reconnectProviders } : {}),
    io,
    integrations: resolvers.integrations ?? defaultIntegrationResolver({
      mode,
      workspace,
      token: () => activeToken,
      cloudUrl,
      io
    }),
    ...(resolvers.authRecovery
      ? {
          authRecovery: authRecoveryForIntegrations(
            resolvers.authRecovery,
            () => activeToken,
            (nextToken) => { activeToken = nextToken; },
            cloudUrl,
            io
          )
        }
      : {}),
    ...(subscription ? { subscription } : {}),
    ...(providerConfigKeys ? { providerConfigKeys } : {})
  });

  // Onboarding pickers: turn picker-annotated inputs the operator hasn't set
  // into a choose-from-a-list prompt, now that the backing integrations are
  // connected. Cloud mode gets a cloud-backed resolver by default; callers can
  // inject their own (or a fake for tests) via `resolvers.integrationOptions`.
  let resolvedInputs: Record<string, string> = { ...(opts.inputs ?? {}) };
  const optionsResolver =
    resolvers.integrationOptions ??
    (mode === 'cloud'
      ? relayfileOptionsResolver({
          apiUrl: normalizeCloudUrl(cloudUrl ?? defaultApiUrl()),
          workspaceToken: () => activeToken
        })
      : undefined);
  if (optionsResolver && opts.noPrompt !== true && (preflight.persona.inputs !== undefined)) {
    resolvedInputs = await collectPickerInputs({
      persona: preflight.persona,
      workspace,
      io,
      resolver: optionsResolver,
      inputs: resolvedInputs,
      connectedProviders: connectedIntegrations,
      ...(opts.noPrompt ? { noPrompt: true } : {})
    });
  }

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

  const runtimeEnv = await resolveRuntimeCredentialEnv({
    mode,
    persona: preflight.persona,
    agent: preflight.agent,
    workspace,
    workspaceToken: activeToken,
    cloudUrl,
    byoSandbox: opts.byoSandbox === true,
    enabled: resolvers.integrations === undefined,
    ...(providerConfigKeys ? { providerConfigKeys } : {})
  });

  io.info(`mode: ${mode}`);
  const launcher = resolveLauncher(mode, resolvers);
  const handle = await launcher.launch({
    persona: preflight.persona,
    agent: preflight.agent,
    bundle,
    workspace,
    io,
    ...(runtimeEnv ? { env: runtimeEnv } : {}),
    ...(activeToken ? { workspaceToken: activeToken } : {}),
    ...(opts.detach ? { detach: true } : {}),
    ...(opts.byoSandbox ? { byoSandbox: true } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(opts.noPrompt ? { noPrompt: true } : {}),
    ...(opts.harnessSource ? { harnessSource: opts.harnessSource } : {}),
    ...(opts.byokKey ? { byokKey: opts.byokKey } : {}),
    ...(opts.onExists ? { onExists: opts.onExists } : {}),
    ...(Object.keys(resolvedInputs).length > 0 ? { inputs: resolvedInputs } : {}),
    ...(credentialSelections ? { credentialSelections } : {}),
    ...(opts.onLog ? { onLog: opts.onLog } : {})
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

async function connectAndCollectIntegrations(input: ConnectAllInput): Promise<string[]> {
  const connectResult = await connectIntegrations(input);
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
  return connectResult.outcomes
    .filter((o) => o.status === 'already-connected' || o.status === 'connected-now')
    .map((o) => o.provider);
}

function defaultIntegrationResolver(args: {
  mode: DeployMode;
  workspace: string;
  token: string | (() => string | Promise<string>);
  cloudUrl?: string;
  io: DeployIO;
}): IntegrationConnectResolver {
  const relayfile = relayfileIntegrationResolver({
    apiUrl: normalizeCloudUrl(args.cloudUrl ?? defaultApiUrl()),
    workspaceId: args.workspace,
    workspaceToken: args.token,
    io: args.io
  });
  if (args.mode === 'cloud') return relayfile;

  const env = envIntegrationResolver();
  return {
    async isConnected(input) {
      if (await relayfile.isConnected(input).catch(() => false)) return true;
      return env.isConnected(input);
    },
    async connect(input) {
      return relayfile.connect(input);
    }
  };
}

type RuntimeCredentialsResponse = {
  relayfileUrl?: unknown;
  relayfileWorkspaceId?: unknown;
  relayfileToken?: unknown;
  relayfileMountPaths?: unknown;
};

type RuntimeCredentials = {
  relayfileUrl: string;
  relayfileWorkspaceId: string;
  relayfileToken: string | null;
  relayfileMountPaths: string[];
};

async function resolveRuntimeCredentialEnv(args: {
  mode: DeployMode;
  persona: PersonaSpec;
  agent: AgentSpec;
  workspace: string;
  workspaceToken: string;
  cloudUrl?: string;
  byoSandbox: boolean;
  enabled: boolean;
  providerConfigKeys?: ProviderConfigKeyResolver;
}): Promise<Record<string, string> | undefined> {
  if (!args.enabled || !shouldRequestRuntimeCredentials(args)) {
    return undefined;
  }
  const integrations = args.persona.integrations ?? {};
  if (Object.keys(integrations).length === 0) {
    return undefined;
  }
  // The runtime-credentials endpoint scopes the relayfile writeback token by
  // the events the agent listens for. Triggers now live on the agent, so merge
  // them back onto the per-provider integration config the cloud expects.
  const credentialIntegrations = buildCredentialIntegrations(integrations, args.agent.triggers);
  const relayfile = relayfileIntegrationResolver({
    apiUrl: normalizeCloudUrl(args.cloudUrl ?? defaultApiUrl()),
    workspaceId: args.workspace,
    workspaceToken: args.workspaceToken
  });
  for (const [provider, integration] of Object.entries(integrations)) {
    const expectedConfigKey = args.providerConfigKeys
      ? await args.providerConfigKeys.resolve(provider).catch(() => undefined)
      : undefined;
    const connected = await relayfile
      .isConnected({
        workspace: args.workspace,
        provider,
        source: integration?.source ?? { kind: 'deployer_user' },
        allowWorkspaceFallback: integrationAllowsWorkspaceFallback(integration),
        ...(expectedConfigKey ? { expectedConfigKey } : {})
      })
      .catch(() => false);
    if (!connected) {
      return undefined;
    }
  }

  const credentials = await requestRuntimeCredentials({
    cloudUrl: normalizeCloudUrl(args.cloudUrl ?? defaultApiUrl()),
    workspace: args.workspace,
    workspaceToken: args.workspaceToken,
    personaId: args.persona.id,
    integrations: credentialIntegrations
  });
  if (credentials.relayfileToken !== null && !credentials.relayfileToken.startsWith('relay_pa_')) {
    throw new Error('runtime-credentials returned a token without expected relay_pa_ prefix');
  }
  if (credentials.relayfileToken !== null && credentials.relayfileMountPaths.length === 0) {
    throw new Error('runtime-credentials returned a token without relayfile mount paths');
  }

  return runtimeCredentialEnv(credentials, credentialIntegrations);
}

/**
 * Integration config shape sent to the runtime-credentials endpoint: the
 * persona's per-provider connection config (source/scope) merged with the
 * agent's triggers for that provider. Triggers no longer live on the persona,
 * so this is the join point that preserves the endpoint's existing contract.
 */
type CredentialIntegrations = Record<
  string,
  {
    source?: IntegrationSource;
    scope?: Record<string, string>;
    triggers?: readonly PersonaIntegrationTrigger[];
  }
>;

function buildCredentialIntegrations(
  integrations: NonNullable<PersonaSpec['integrations']>,
  triggers: AgentSpec['triggers']
): CredentialIntegrations {
  const out: CredentialIntegrations = {};
  for (const [provider, cfg] of Object.entries(integrations)) {
    const providerTriggers = triggers?.[provider];
    out[provider] = {
      ...(cfg?.source ? { source: cfg.source } : {}),
      ...(cfg?.scope ? { scope: cfg.scope } : {}),
      ...(providerTriggers && providerTriggers.length > 0 ? { triggers: providerTriggers } : {})
    };
  }
  return out;
}

function shouldRequestRuntimeCredentials(args: {
  mode: DeployMode;
  byoSandbox: boolean;
}): boolean {
  if (args.mode === 'cloud') return false;
  if (args.mode === 'dev') return true;
  return args.byoSandbox || hasByoSandboxEnv();
}

function integrationAllowsWorkspaceFallback(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { __agentworkforceImplicitSource?: unknown }).__agentworkforceImplicitSource === true
  );
}

function hasByoSandboxEnv(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY?.trim() || process.env.DAYTONA_JWT_TOKEN?.trim());
}

async function requestRuntimeCredentials(args: {
  cloudUrl: string;
  workspace: string;
  workspaceToken: string;
  personaId: string;
  integrations: CredentialIntegrations;
}): Promise<RuntimeCredentials> {
  const response = await fetch(
    `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(args.workspace)}/runtime-credentials`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.workspaceToken}`,
        'content-type': 'application/json',
        'user-agent': 'workforce-deploy'
      },
      body: JSON.stringify({
        personaId: args.personaId,
        agentId: args.personaId,
        integrations: args.integrations,
        ttlSeconds: 3600
      })
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`runtime-credentials request failed: ${response.status} ${text}`.trim());
  }
  return parseRuntimeCredentials(await response.json());
}

function parseRuntimeCredentials(body: RuntimeCredentialsResponse): RuntimeCredentials {
  const relayfileUrl = typeof body.relayfileUrl === 'string' ? body.relayfileUrl.trim() : '';
  const relayfileWorkspaceId = typeof body.relayfileWorkspaceId === 'string'
    ? body.relayfileWorkspaceId.trim()
    : '';
  const relayfileToken = body.relayfileToken === null
    ? null
    : typeof body.relayfileToken === 'string'
      ? body.relayfileToken.trim()
      : '';
  const relayfileMountPaths = Array.isArray(body.relayfileMountPaths)
    ? body.relayfileMountPaths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!relayfileUrl || !relayfileWorkspaceId || relayfileToken === '') {
    throw new Error(
      `runtime-credentials response missing relayfileUrl/relayfileWorkspaceId/relayfileToken: ${JSON.stringify(body)}`
    );
  }
  return {
    relayfileUrl,
    relayfileWorkspaceId,
    relayfileToken,
    relayfileMountPaths
  };
}

function runtimeCredentialEnv(
  credentials: RuntimeCredentials,
  integrations: CredentialIntegrations
): Record<string, string> {
  const env: Record<string, string> = {
    RELAYFILE_URL: credentials.relayfileUrl,
    RELAYFILE_WORKSPACE_ID: credentials.relayfileWorkspaceId,
    RELAYFILE_TOKEN: credentials.relayfileToken ?? '',
    RELAYFILE_MOUNT_PATHS: JSON.stringify(credentials.relayfileMountPaths)
  };
  for (const provider of Object.keys(integrations)) {
    env[`WORKFORCE_INTEGRATION_${provider.toUpperCase()}_TOKEN`] = '';
    env[`WORKFORCE_INTEGRATION_${provider.toUpperCase()}_CONNECTION_ID`] = '';
  }
  return env;
}

function validateSubscriptionSupport(
  persona: PersonaSpec,
  args: {
    mode: DeployMode;
    subscription?: ProviderSubscriptionResolver;
    harnessSource?: 'plan' | 'byok' | 'oauth';
  }
): void {
  if (!persona.useSubscription || args.subscription) return;
  if (args.mode !== 'cloud') {
    throw new Error(
      `persona "${persona.id}" sets useSubscription:true, which requires --mode cloud so the deploy CLI can connect an LLM provider. ` +
        'Use --mode cloud with --harness-source oauth or byok, or remove useSubscription to use workforce-billed inference.'
    );
  }
  validateCloudSubscriptionSupport({
    persona,
    ...(args.harnessSource ? { harnessSource: args.harnessSource } : {})
  });
}

function alreadyConnectedSubscriptionResolver(provider: string): ProviderSubscriptionResolver {
  return {
    async isConnected() {
      return true;
    },
    async connect() {
      return { provider };
    }
  };
}

function authRecoveryForIntegrations(
  resolver: CloudAuthRecoveryResolver,
  currentToken: () => string,
  setToken: (token: string) => void,
  cloudUrl: string,
  io: DeployIO
): IntegrationAuthRecoveryResolver {
  return {
    async recover({ workspace, provider, reason }) {
      const result = await resolver.recover({
        workspace,
        cloudUrl,
        io,
        provider,
        reason
      });
      if (!result) return false;
      if (result.token && result.token !== currentToken()) {
        setToken(result.token);
      }
      return true;
    }
  };
}

function normalizeCloudUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : defaultApiUrl().replace(/\/+$/, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
