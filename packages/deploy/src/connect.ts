import { platform } from 'node:os';
import { spawn } from 'node:child_process';
import type { IntegrationSource, PersonaSpec } from '@agentworkforce/persona-kit';
import type { DeployIO, IntegrationConnectOutcome } from './types.js';

/**
 * Provider env-var conventions the deploy CLI checks when no higher-level
 * integration resolver is supplied. The convention is:
 *
 *   - `WORKFORCE_INTEGRATION_<PROVIDER>_TOKEN` — direct provider token
 *     (e.g. `WORKFORCE_INTEGRATION_GITHUB_TOKEN`). Treated as "connected"
 *     when present and non-empty.
 *   - or `WORKFORCE_INTEGRATION_<PROVIDER>_CONNECTION_ID` — Relayfile
 *     connection id, resolved to a scoped token at runtime by the agent.
 *
 * The connect side is a no-op for the env path: there is nothing to
 * authenticate interactively. Authors plug a higher-level resolver into
 * `DeployResolvers.integrations` once Relayfile's OAuth surface is wired.
 */
const PROVIDER_ENV_PREFIX = 'WORKFORCE_INTEGRATION_';

/**
 * Resolver the orchestrator uses to check + connect a Relayfile-backed
 * provider for the active workspace. The deploy package does not depend
 * on `@relayfile/sdk` directly; the CLI dispatches the real implementation
 * (which imports the SDK) into this contract.
 *
 * Decoupling this keeps the orchestrator unit-testable without spinning
 * up Relayfile and keeps the SDK out of the deploy package's transitive
 * dep tree (smaller bin, faster install).
 */
export interface IntegrationConnectResolver {
  /**
   * Is the provider already linked to the right scope for this persona?
   *
   * `source` discriminates which scope the cloud will resolve at dispatch
   * time (deployer-user / workspace / workspace-service-account). The
   * preflight check must hit the same scope: a `user_integrations` row
   * does not satisfy a workspace-scoped persona declaration and vice
   * versa. Defaults to `{ kind: 'deployer_user' }` (matches the
   * persona-kit default at parse time).
   *
   * `expectedConfigKey` is the Nango provider-config-key the persona's
   * declared `provider` resolves to (e.g. provider `slack` →
   * `slack-relay`). When supplied, rows whose `providerConfigKey` does
   * not match are ignored — protecting against false positives when the
   * workspace has multiple Slack providers (slack-relay / slack-ricky /
   * slack-nightcto / slack-my-senior-dev / slack-sage).
   */
  isConnected(args: {
    workspace: string;
    provider: string;
    source?: IntegrationSource;
    expectedConfigKey?: string;
    allowWorkspaceFallback?: boolean;
  }): Promise<boolean>;
  /**
   * Run the browser-based OAuth flow and resolve when the user finishes.
   *
   * `source` discriminates which table the cloud writes the new row into:
   * `deployer_user` → `user_integrations`, `workspace` → `workspace_integrations`,
   * `workspace_service_account` → `workspace_integrations` with a named
   * service-account attribution. The CLI passes the persona's declared
   * source so the connect-side scope matches the preflight read scope and
   * the runtime dispatcher's resolve scope (per `cloud#1001`).
   *
   * Defaults to `{ kind: 'deployer_user' }` (mirrors the persona-kit
   * default).
   */
  connect(args: {
    workspace: string;
    provider: string;
    source?: IntegrationSource;
    allowWorkspaceFallback?: boolean;
  }): Promise<{ connectionId: string }>;
}

/**
 * Provider linker for `useSubscription: true` personas — connects the
 * user's chosen LLM provider so cloud inference is billed against their
 * subscription rather than workforce.
 */
export interface ProviderSubscriptionResolver {
  isConnected(args: { workspace: string; providerHint?: string }): Promise<boolean>;
  connect(args: { workspace: string; providerHint?: string }): Promise<{ provider: string }>;
}

/**
 * Called after a cloud integration status check gets a 401. The CLI uses
 * this to run the established browser login flow, refresh the active bearer
 * token, and let the status check retry once.
 */
export interface IntegrationAuthRecoveryResolver {
  recover(args: { workspace: string; provider: string; reason: string }): Promise<boolean>;
}

/**
 * Resolver backed by env vars. Used as the default when no higher-level
 * implementation is plugged in. `isConnected` returns true exactly when
 * one of the two recognized env vars is set for the provider; `connect`
 * is a no-op that records the env-resolved nature of the connection so
 * the orchestrator's flow stays uniform across resolvers.
 */
export function envIntegrationResolver(): IntegrationConnectResolver {
  return {
    async isConnected({ provider }) {
      return providerHasEnvCredentials(provider);
    },
    async connect({ provider }) {
      if (!providerHasEnvCredentials(provider)) {
        throw new Error(
          `env resolver: ${provider} is not connected. Set ${PROVIDER_ENV_PREFIX}${provider.toUpperCase()}_TOKEN or ${PROVIDER_ENV_PREFIX}${provider.toUpperCase()}_CONNECTION_ID, then re-run deploy. (Higher-level resolvers — e.g. a Relayfile OAuth flow — plug in via DeployResolvers.integrations.)`
        );
      }
      return { connectionId: `env:${provider}` };
    }
  };
}

export function relayfileIntegrationResolver(opts: {
  apiUrl: string;
  workspaceId: string;
  workspaceToken: string | (() => string | Promise<string>);
  io?: Pick<DeployIO, 'info' | 'warn'>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  openUrl?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): IntegrationConnectResolver {
  const fetchImpl = opts.fetch ?? fetch;
  const io = opts.io;
  const sleepImpl = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');

  return {
    async isConnected({
      workspace,
      provider,
      source,
      expectedConfigKey,
      allowWorkspaceFallback
    }) {
      const workspaceId = workspace || opts.workspaceId;
      const token = await resolveWorkspaceToken(opts.workspaceToken);
      const effectiveSource: IntegrationSource = source ?? { kind: 'deployer_user' };

      const status = await fetchIntegrationStatusForScope({
        fetchImpl,
        apiUrl,
        token,
        workspaceId,
        provider,
        source: effectiveSource,
        io
      });
      if (statusIsConnectedForSource(status, provider, effectiveSource, expectedConfigKey)) {
        return true;
      }

const fallbackSource = workspaceFallbackSource(
        effectiveSource,
        allowWorkspaceFallback === true
      );
      if (!fallbackSource) return false;

      const fallbackStatus = await fetchIntegrationStatusForScope({
        fetchImpl,
        apiUrl,
        token,
        workspaceId,
        provider,
        source: fallbackSource,
        io
      });
      return statusIsConnectedForSource(
        fallbackStatus,
        provider,
        fallbackSource,
        expectedConfigKey
      );
    },
    async connect({ workspace, provider, source, allowWorkspaceFallback }) {
      const workspaceId = workspace || opts.workspaceId;
      const token = await resolveWorkspaceToken(opts.workspaceToken);
      const effectiveSource: IntegrationSource = source ?? { kind: 'deployer_user' };

      // Tell the cloud which table to write the new row into. Per
      // AgentWorkforce/cloud#1001, when `scope` is omitted the cloud
      // defaults to `workspace` (today's behavior) so older clouds keep
      // working. When `scope` is supplied, the cloud routes the row to
      // user_integrations / workspace_integrations / service-account-named
      // workspace_integrations accordingly, matching what the runtime
      // dispatcher reads at tick time.
      const sessionBody = {
        allowedIntegrations: [provider],
        scope: scopeRequest(effectiveSource),
        ...(provider === 'github' && effectiveSource.kind === 'deployer_user'
          ? { githubInstallationFlow: true }
          : {})
      };
      let session: unknown;
      try {
        session = await requestJson(fetchImpl, `${apiUrl}/api/v1/workspaces/${encodeURIComponent(
          workspaceId
        )}/integrations/connect-session`, token, {
          method: 'POST',
          body: JSON.stringify(sessionBody)
        });
      } catch (err) {
        // Turn the cloud's `409 unknown_provider` into an actionable message:
        // the integration key must be the cloud provider id (e.g. `google-mail`),
        // not the adapter slug (`gmail`). Suggest the closest valid id.
        if (isCloudRequestError(err) && err.code === 'unknown_provider') {
          const valid = err.providers ?? [];
          const suggestion = suggestProvider(provider, valid);
          throw cloudRequestError(
            `integration provider "${provider}" is not available in workspace ${workspaceId}.` +
              (suggestion
                ? ` Did you mean "${suggestion}"? The integration key must be the cloud provider id, not the adapter slug (e.g. Gmail is "google-mail", not "gmail").`
                : '') +
              (valid.length ? ` Valid providers: ${valid.join(', ')}.` : ''),
            err.status,
            { code: 'unknown_provider', providers: valid }
          );
        }
        throw err;
      }
      const sessionUrl = readString(session, 'sessionUrl')
        ?? readString(session, 'connectLink')
        ?? readString(session, 'url');
      const githubFlow = readGithubInstallationFlow(session);
      if (provider === 'github' && githubFlow?.enabled === true) {
        const inherited = await tryConnectExistingGithubInstallation({
          fetchImpl,
          apiUrl,
          workspaceToken: opts.workspaceToken,
          workspaceId,
          session,
          sessionUrl,
          flow: githubFlow,
          io,
          openUrl: opts.openUrl,
          sleep: sleepImpl,
          pollIntervalMs: opts.pollIntervalMs,
          timeoutMs: opts.timeoutMs
        });
        if (inherited) return inherited;

        const installToken = await resolveWorkspaceToken(opts.workspaceToken);
        session = await requestJson(fetchImpl, `${apiUrl}/api/v1/workspaces/${encodeURIComponent(
          workspaceId
        )}/integrations/connect-session`, installToken, {
          method: 'POST',
          body: JSON.stringify({
            allowedIntegrations: [githubFlow.installProviderConfigKey || provider],
            scope: scopeRequest(effectiveSource)
          })
        });
      }
      const installSessionUrl = readString(session, 'sessionUrl')
        ?? readString(session, 'connectLink')
        ?? readString(session, 'url');
      if (!installSessionUrl) {
        throw new Error(`integration ${provider} connect-session did not return a session URL`);
      }
      const sessionId = readString(session, 'sessionId') ?? readString(session, 'connectionId');
      const sessionConfigKey = readProviderConfigKey(session);
      io?.info(`Connecting ${provider}: opening ${installSessionUrl}`);
      try {
        await (opts.openUrl ?? openBrowser)(installSessionUrl);
      } catch (err) {
        io?.warn?.(`Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`);
      }

      const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
      while (Date.now() < deadline) {
        await sleepImpl(opts.pollIntervalMs ?? 2_000);
        const pollToken = await resolveWorkspaceToken(opts.workspaceToken);
        const statusArgs = {
          fetchImpl,
          apiUrl,
          token: pollToken,
          workspaceId,
          provider,
          source: effectiveSource,
          io
        };
        const status = await fetchIntegrationStatusForScope({
          ...statusArgs,
          ...(sessionId ? { connectionId: sessionId } : {})
        });
        if (statusIsConnectedForSource(status, provider, effectiveSource)) {
          const connectionId = readConnectionId(status)
            ?? sessionId
            ?? provider;
          io?.info(`${provider} connected.`);
          return { connectionId };
        }

        if (sessionId) {
          const canonicalStatus = await fetchIntegrationStatusForScope(statusArgs);
          if (statusIsConnectedForSource(
            canonicalStatus,
            provider,
            effectiveSource,
            sessionConfigKey
          )) {
            const connectionId = readConnectionId(canonicalStatus)
              ?? sessionId
              ?? provider;
            io?.info(`${provider} connected.`);
            return { connectionId };
          }
        }

        const fallbackSource = workspaceFallbackSource(
          effectiveSource,
          allowWorkspaceFallback === true
        );
        if (fallbackSource) {
          const fallbackStatus = await fetchIntegrationStatusForScope({
            fetchImpl,
            apiUrl,
            token: pollToken,
            workspaceId,
            provider,
            source: fallbackSource,
            ...(sessionId ? { connectionId: sessionId } : {}),
            io
          });
          if (
            statusIsConnectedForSource(
              fallbackStatus,
              provider,
              fallbackSource,
              sessionConfigKey
            ) &&
            statusMatchesConnectionId(fallbackStatus, sessionId)
          ) {
            const connectionId = readConnectionId(fallbackStatus)
              ?? sessionId
              ?? provider;
            io?.info(`${provider} connected.`);
            return { connectionId };
          }
          if (sessionId) {
            const canonicalFallbackStatus = await fetchIntegrationStatusForScope({
              fetchImpl,
              apiUrl,
              token: pollToken,
              workspaceId,
              provider,
              source: fallbackSource,
              io
            });
            if (
              statusIsConnectedForSource(
                canonicalFallbackStatus,
                provider,
                fallbackSource,
                sessionConfigKey
              )
            ) {
              const connectionId = readConnectionId(canonicalFallbackStatus)
                ?? sessionId
                ?? provider;
              io?.info(`${provider} connected.`);
              return { connectionId };
            }
          }
        }
      }

      throw new Error(
        `Timed out waiting for ${provider} OAuth to complete. Re-run \`agentworkforce deploy ...\` after connecting.`
      );
    }
  };
}

/**
 * Translate the persona's typed `IntegrationSource` into the JSON shape the
 * cloud connect-session endpoint accepts (per AgentWorkforce/cloud#1001).
 */
function scopeRequest(
  source: IntegrationSource
): { kind: 'deployer_user' | 'workspace' | 'workspace_service_account'; name?: string } {
  if (source.kind === 'workspace_service_account') {
    return { kind: 'workspace_service_account', name: source.name };
  }
  return { kind: source.kind };
}

interface GithubInstallationFlow {
  enabled: true;
  oauthProviderConfigKey?: string;
  installProviderConfigKey?: string;
}

interface GithubInstallationMatch {
  installationId: string;
  accountLogin?: string | null;
  accountType?: string | null;
  suspended?: boolean;
}

interface GithubReconcileResponse {
  matches?: GithubInstallationMatch[];
}

interface GithubJoinResponse {
  outcome?: string;
  landingWorkspace?: { id?: string; slug?: string | null; name?: string | null } | null;
}

function readGithubInstallationFlow(session: unknown): GithubInstallationFlow | undefined {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return undefined;
  const flow = (session as { githubInstallationFlow?: unknown }).githubInstallationFlow;
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return undefined;
  if ((flow as { enabled?: unknown }).enabled !== true) return undefined;
  return {
    enabled: true,
    oauthProviderConfigKey: readString(flow, 'oauthProviderConfigKey'),
    installProviderConfigKey: readString(flow, 'installProviderConfigKey')
  };
}

async function tryConnectExistingGithubInstallation(args: {
  fetchImpl: typeof fetch;
  apiUrl: string;
  workspaceToken: string | (() => string | Promise<string>);
  workspaceId: string;
  session: unknown;
  sessionUrl: string | undefined;
  flow: GithubInstallationFlow;
  io?: Pick<DeployIO, 'info' | 'warn'>;
  openUrl?: (url: string) => void | Promise<void>;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ connectionId: string } | undefined> {
  if (!args.sessionUrl) {
    throw new Error('GitHub user authorization session did not return a session URL');
  }
  const oauthConnectionId = readString(args.session, 'connectionId') ?? readString(args.session, 'sessionId');
  if (!oauthConnectionId) {
    throw new Error('GitHub user authorization session did not return a connection id');
  }

  args.io?.info(`Connecting github: opening ${args.sessionUrl}`);
  try {
    await (args.openUrl ?? openBrowser)(args.sessionUrl);
  } catch (err) {
    args.io?.warn?.(`Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`);
  }

  const deadline = Date.now() + (args.timeoutMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    await args.sleep(args.pollIntervalMs ?? 2_000);
    const token = await resolveWorkspaceToken(args.workspaceToken);
    const reconcile = await readGithubReconcile({ ...args, token }, oauthConnectionId);
    if (!reconcile) continue;

    const match = reconcile.matches?.find((candidate) => (
      candidate.accountType === 'Organization' && candidate.suspended !== true
    ));
    if (!match) return undefined;

    const joinToken = await resolveWorkspaceToken(args.workspaceToken);
    const join = await postGithubJoin(
      { ...args, token: joinToken },
      {
        installationId: match.installationId,
        oauthConnectionId
      }
    );
    if (join.outcome === 'joined' || join.outcome === 'already_member') {
      const destination = join.landingWorkspace?.name
        ?? join.landingWorkspace?.slug
        ?? join.landingWorkspace?.id
        ?? 'the organization workspace';
      args.io?.info(
        `integrations.github: already connected via ${match.accountLogin ?? 'GitHub'}; using ${destination}`
      );
      return { connectionId: `github-installation:${match.installationId}` };
    }
    if (join.outcome === 'pending_approval') {
      throw new Error(
        `GitHub App is already installed for ${match.accountLogin ?? 'this organization'}, but joining is pending owner/admin approval.`
      );
    }
    return undefined;
  }

  throw new Error('Timed out waiting for GitHub user authorization to complete.');
}

async function readGithubReconcile(
  args: { fetchImpl: typeof fetch; apiUrl: string; token: string; workspaceId: string },
  oauthConnectionId: string
): Promise<GithubReconcileResponse | undefined> {
  try {
    return await requestJson(
      args.fetchImpl,
      `${args.apiUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/integrations/github/reconcile`,
      args.token,
      {
        method: 'POST',
        body: JSON.stringify({ oauthConnectionId })
      }
    ) as GithubReconcileResponse;
  } catch (err) {
    if (
      isCloudRequestError(err) &&
      (err.status === 409 || err.status === 502)
    ) {
      return undefined;
    }
    throw err;
  }
}

async function postGithubJoin(
  args: { fetchImpl: typeof fetch; apiUrl: string; token: string; workspaceId: string },
  body: { installationId: string; oauthConnectionId: string }
): Promise<GithubJoinResponse> {
  return await requestJson(
    args.fetchImpl,
    `${args.apiUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/integrations/github/join`,
    args.token,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  ) as GithubJoinResponse;
}

function providerHasEnvCredentials(provider: string): boolean {
  const upper = provider.toUpperCase();
  return Boolean(
    process.env[`${PROVIDER_ENV_PREFIX}${upper}_TOKEN`] ||
      process.env[`${PROVIDER_ENV_PREFIX}${upper}_CONNECTION_ID`]
  );
}

export interface ConnectAllInput {
  persona: PersonaSpec;
  workspace: string;
  noConnect: boolean;
  noPrompt?: boolean;
  reconnectProviders?: readonly string[];
  io: DeployIO;
  integrations: IntegrationConnectResolver;
  /** Optional cloud-login recovery for interactive 401s. */
  authRecovery?: IntegrationAuthRecoveryResolver;
  /** Required only when persona.useSubscription is true. */
  subscription?: ProviderSubscriptionResolver;
  /**
   * Optional resolver for the Nango provider-config-key behind each provider
   * id. Backed by `GET /api/v1/integrations/catalog`. When supplied, the
   * walker passes the expected config-key into the resolver's `isConnected`
   * call so e.g. a persona declaring `slack` is verified against the
   * `slack-relay` config-key specifically, ignoring rows backed by other
   * Slack providers (slack-ricky / slack-nightcto / slack-sage / etc.).
   *
   * When omitted, the walker falls back to provider-name-only matching,
   * which is sufficient for providers that have a single config-key but
   * loses precision for ambiguous ones.
   */
  providerConfigKeys?: ProviderConfigKeyResolver;
}

/**
 * Returns the expected Nango provider-config-key for a persona-declared
 * provider id. The CLI implementation caches the cloud catalog response
 * after the first lookup to keep deploys cheap.
 */
export interface ProviderConfigKeyResolver {
  resolve(provider: string): Promise<string | undefined>;
}

export interface ConnectAllResult {
  outcomes: IntegrationConnectOutcome[];
  /** Provider the subscription was bound to, when applicable. */
  subscriptionProvider?: string;
}

/**
 * Walk the persona's declared integrations and ensure each is connected.
 * Per the deploy-v1 spec, the orchestrator prompts before each provider's
 * connect flow ("Connect github now? (Y/n)") so users running on a shared
 * machine don't have surprise browser pops.
 *
 * Behavior summary:
 *   - integrations: {} or undefined → returns immediately, no prompts
 *   - already-connected provider → no prompt; emits `already-connected`
 *   - 401 while checking status + authRecovery → prompts login and retries once
 *   - other auth failure while checking status → fails without integration prompts
 *   - not connected + noPrompt=true → fails immediately without prompting
 *   - not connected + noConnect=true → fails the deploy with a clear message
 *   - not connected + noConnect=false → prompts; on yes runs `connect`,
 *     on no marks `skipped`. The orchestrator decides what to do with
 *     `skipped` outcomes (today: fails the deploy at the call site).
 */
export async function connectIntegrations(input: ConnectAllInput): Promise<ConnectAllResult> {
  const integrations = input.persona.integrations ?? {};
  const outcomes: IntegrationConnectOutcome[] = [];
  const subscription = input.persona.useSubscription
    ? requireSubscriptionResolver(input.persona.id, input.subscription)
    : undefined;
  const subscriptionProvider = subscription
    ? await connectSubscriptionProvider(input, subscription)
    : undefined;

  for (const provider of Object.keys(integrations)) {
    const integrationEntry = integrations[provider] ?? {};
    const source: IntegrationSource = integrationEntry.source ?? { kind: 'deployer_user' };
    const forceReconnect = input.reconnectProviders?.includes(provider) ?? false;
    const expectedConfigKey = input.providerConfigKeys
      ? await input.providerConfigKeys.resolve(provider).catch(() => undefined)
      : undefined;

    let statusCheckFailure: string | undefined;
    let connected = await checkProviderConnected(
      input,
      provider,
      source,
      expectedConfigKey,
      (message) => {
        statusCheckFailure = message;
      }
    );

    if (connected && !forceReconnect) {
      input.io.info(`integrations.${provider}: already connected`);
      outcomes.push({ provider, status: 'already-connected' });
      continue;
    }
    if (connected && forceReconnect) {
      input.io.info(`integrations.${provider}: reconnect requested; opening a fresh connection flow`);
    }

    if (
      statusCheckFailure
      && isIntegrationUnauthorizedFailure(statusCheckFailure)
      && !input.noPrompt
      && input.authRecovery
    ) {
      const recovered = await input.authRecovery
        .recover({ workspace: input.workspace, provider, reason: statusCheckFailure })
        .catch((err) => {
          input.io.error(
            `integrations.${provider}: login failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return false;
        });

      if (recovered) {
        statusCheckFailure = undefined;
        connected = await checkProviderConnected(
          input,
          provider,
          source,
          expectedConfigKey,
          (message) => {
            statusCheckFailure = message;
          }
        );
        if (connected && !forceReconnect) {
          input.io.info(`integrations.${provider}: already connected`);
          outcomes.push({ provider, status: 'already-connected' });
          continue;
        }
      }
    }

    if (statusCheckFailure) {
      input.io.error(
        `integrations.${provider}: ${isIntegrationAuthFailure(statusCheckFailure) ? 'auth failed' : 'failed'} while checking connection status`
      );
      outcomes.push({
        provider,
        status: 'failed',
        message: statusCheckFailure
      });
      continue;
    }

    if (input.noPrompt && !forceReconnect) {
      input.io.error(
        `integrations.${provider}: not connected, and --no-prompt was passed. Connect it before deploying or run without --no-prompt.`
      );
      outcomes.push({
        provider,
        status: 'failed',
        message: 'not connected (--no-prompt was set)'
      });
      return { outcomes };
    }

    if (input.noConnect && !forceReconnect) {
      input.io.error(
        `integrations.${provider}: not connected, and prompts are disabled`
      );
      outcomes.push({
        provider,
        status: 'failed',
        message: 'not connected (prompts are disabled)'
      });
      continue;
    }

    if (!forceReconnect) {
      const shouldConnect = await input.io.confirm(
        `Connect ${provider} now? (opens browser)`,
        { defaultValue: true }
      );
      if (!shouldConnect) {
        outcomes.push({ provider, status: 'skipped', message: 'user declined to connect' });
        continue;
      }
    }

    try {
      const result = await input.integrations.connect({
        workspace: input.workspace,
        provider,
        source,
        allowWorkspaceFallback: integrationAllowsWorkspaceFallback(integrationEntry)
      });
      input.io.info(`integrations.${provider}: connected (${result.connectionId})`);
      outcomes.push({ provider, status: 'connected-now' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.io.error(`integrations.${provider}: connect failed: ${message}`);
      outcomes.push({ provider, status: 'failed', message });
    }
  }

  return {
    outcomes,
    ...(subscriptionProvider ? { subscriptionProvider } : {})
  };
}

async function connectSubscriptionProvider(
  input: ConnectAllInput,
  subscription: ProviderSubscriptionResolver
): Promise<string | undefined> {
  const isConn = await subscription
    .isConnected({ workspace: input.workspace })
    .catch(() => false);
  if (isConn) {
    input.io.info('subscription: already connected');
    return undefined;
  }
  if (input.noPrompt) {
    throw new Error(
      'persona requires a subscription provider connection, but --no-prompt was passed. Connect it before deploying or run without --no-prompt.'
    );
  }
  if (input.noConnect) {
    throw new Error(
      'persona requires a subscription provider connection, but --no-connect was passed'
    );
  }
  const ok = await input.io.confirm(
    'persona has useSubscription:true — connect your LLM provider now?',
    { defaultValue: true }
  );
  if (!ok) {
    throw new Error('user declined the subscription provider connect; deploy aborted');
  }
  const result = await subscription.connect({ workspace: input.workspace });
  input.io.info(`subscription: connected (${result.provider})`);
  return result.provider;
}

function requireSubscriptionResolver(
  personaId: string,
  subscription: ProviderSubscriptionResolver | undefined
): ProviderSubscriptionResolver {
  if (subscription) return subscription;
  throw new Error(
    `persona "${personaId}" sets useSubscription:true, but no subscription connector is available. ` +
      'Use the deploy orchestrator cloud mode, provide a subscription resolver, or remove useSubscription to use workforce-billed inference.'
  );
}

async function checkProviderConnected(
  input: ConnectAllInput,
  provider: string,
  source: IntegrationSource,
  expectedConfigKey: string | undefined,
  onFailure: (message: string) => void
): Promise<boolean> {
  return await input.integrations
    .isConnected({
      workspace: input.workspace,
      provider,
      source,
      allowWorkspaceFallback: integrationAllowsWorkspaceFallback(
        input.persona.integrations?.[provider]
      ),
      ...(expectedConfigKey ? { expectedConfigKey } : {})
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      onFailure(message);
      input.io.warn(`failed to check connection status for ${provider}: ${message}`);
      return false;
    });
}

/**
 * Error thrown by `requestJson` for any non-2xx response. Carries the numeric
 * HTTP `status` so callers can branch on it without parsing the message
 * (which can include the response body — body content like "404" inside a
 * 500 response was causing false-positive fallbacks).
 */
interface CloudRequestError extends Error {
  status: number;
  /** Machine-readable error code from the cloud body, when present. */
  code?: string;
  /** Valid provider ids the cloud returned (set on `unknown_provider` 409s). */
  providers?: string[];
}

function cloudRequestError(
  message: string,
  status: number,
  extra: { code?: string; providers?: string[] } = {}
): CloudRequestError {
  const err = new Error(message) as CloudRequestError;
  err.status = status;
  if (extra.code !== undefined) err.code = extra.code;
  if (extra.providers !== undefined) err.providers = extra.providers;
  return err;
}

/**
 * The cloud rejects an unrecognized integration provider with
 * `409 {"error":"unknown_provider","providers":[{id,...},...]}`. Parse that
 * shape so callers can surface the valid ids + a "did you mean" suggestion
 * instead of dumping raw JSON. Returns undefined for any other body.
 */
function parseUnknownProvider(body: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { error?: unknown }).error !== 'unknown_provider'
  ) {
    return undefined;
  }
  const providers = (parsed as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers
    .map((p) => readString(p, 'id'))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Suggest the closest valid provider id to a mistyped one — chiefly to catch
 * the adapter-slug-vs-cloud-id footgun (e.g. `gmail` → `google-mail`). Known
 * aliases win; otherwise we pick the candidate sharing the longest substring,
 * tie-broken by edit distance. Returns undefined when nothing is close.
 */
function suggestProvider(requested: string, candidates: string[]): string | undefined {
  const req = requested.toLowerCase();
  const aliases: Record<string, string> = {
    gmail: 'google-mail',
    googlemail: 'google-mail',
    google_mail: 'google-mail',
    gcal: 'google-calendar',
    googlecalendar: 'google-calendar',
    google_calendar: 'google-calendar',
    dockerhub: 'docker-hub',
    docker_hub: 'docker-hub'
  };
  const aliased = aliases[req];
  if (aliased && candidates.includes(aliased)) return aliased;

  let best: { id: string; lcs: number; dist: number } | undefined;
  for (const id of candidates) {
    const lcs = longestCommonSubstring(req, id.toLowerCase());
    const dist = levenshtein(req, id.toLowerCase());
    if (!best || lcs > best.lcs || (lcs === best.lcs && dist < best.dist)) {
      best = { id, lcs, dist };
    }
  }
  if (!best) return undefined;
  return best.lcs >= 3 || best.dist <= 3 ? best.id : undefined;
}

function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > best) best = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = tmp;
    }
  }
  return row[b.length];
}

function isCloudRequestError(err: unknown): err is CloudRequestError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  if (res.status === 401) {
    throw cloudRequestError(
      'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.',
      401
    );
  }
  if (res.status === 403) {
    throw cloudRequestError(
      'cloud integration request failed: forbidden. The active account is not authorized for this workspace. Run `agentworkforce login --workspace <id-or-slug>` against an account with access, then retry.',
      403
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 409) {
      const providers = parseUnknownProvider(body);
      if (providers) {
        throw cloudRequestError(
          `cloud integration request failed: unknown integration provider.${providers.length ? ` Valid providers: ${providers.join(', ')}.` : ''}`,
          409,
          { code: 'unknown_provider', providers }
        );
      }
    }
    throw cloudRequestError(`cloud integration request failed: ${res.status} ${body}`.trim(), res.status);
  }
  return await res.json();
}

function isIntegrationAuthFailure(message: string): boolean {
  return /cloud integration request failed: (unauthorized|forbidden)\b/i.test(message);
}

function isIntegrationUnauthorizedFailure(message: string): boolean {
  return /cloud integration request failed: unauthorized\b/i.test(message);
}

async function resolveWorkspaceToken(token: string | (() => string | Promise<string>)): Promise<string> {
  return typeof token === 'function' ? await token() : token;
}

/**
 * Fetch the integrations list backing the persona's declared `source`.
 *
 * - `deployer_user` (the default) → `GET /api/v1/me/integrations`
 *   (reads `user_integrations` for the authed cloud user, per
 *   `AgentWorkforce/cloud#988`).
 * - `workspace` / `workspace_service_account` → `GET /api/v1/workspaces/<id>/integrations`
 *   (reads `workspace_integrations`).
 *
 * Backwards-compat: if `/me/integrations` is unavailable (older cloud that
 * hasn't shipped cloud#988 yet), fall back to the workspace endpoint with a
 * warning. Authors deploying personas with `source: { kind: 'deployer_user' }`
 * against an older cloud will see false negatives, but the deploy still
 * surfaces a clean error rather than silently mis-resolving.
 */
async function fetchIntegrationsForScope(args: {
  fetchImpl: typeof fetch;
  apiUrl: string;
  token: string;
  workspaceId: string;
  source: IntegrationSource;
  io?: Pick<DeployIO, 'info' | 'warn'>;
}): Promise<unknown> {
  if (args.source.kind === 'deployer_user') {
    const url = `${args.apiUrl}/api/v1/me/integrations`;
    try {
      return await requestJson(args.fetchImpl, url, args.token);
    } catch (err) {
      // Only fall back when the endpoint itself is missing (older cloud that
      // hasn't shipped cloud#988). Any other failure — auth, 5xx, network —
      // must propagate so callers see the real error and can drive the
      // existing auth-recovery flow rather than silently masking the cause.
      if (isCloudRequestError(err) && (err.status === 404 || err.status === 405)) {
        args.io?.warn?.(
          'cloud does not expose /api/v1/me/integrations yet; falling back to the workspace integrations list. ' +
            'Deployer-user-scoped connections may show as not-connected. ' +
            'Tracking in AgentWorkforce/cloud#988.'
        );
        return await requestJson(
          args.fetchImpl,
          `${args.apiUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/integrations`,
          args.token
        );
      }
      throw err;
    }
  }
  return await requestJson(
    args.fetchImpl,
    `${args.apiUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/integrations`,
    args.token
  );
}

async function fetchIntegrationStatusForScope(args: {
  fetchImpl: typeof fetch;
  apiUrl: string;
  token: string;
  workspaceId: string;
  provider: string;
  source: IntegrationSource;
  connectionId?: string;
  io?: Pick<DeployIO, 'info' | 'warn'>;
}): Promise<unknown> {
  const url = new URL(
    `${args.apiUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/integrations/${encodeURIComponent(args.provider)}/status`
  );
  if (args.connectionId) url.searchParams.set('connectionId', args.connectionId);
  url.searchParams.set('scope', args.source.kind);
  if (args.source.kind === 'workspace_service_account') {
    url.searchParams.set('serviceAccountName', args.source.name);
  }
  try {
    return await requestJson(args.fetchImpl, url.toString(), args.token);
  } catch (err) {
    if (isCloudRequestError(err) && (err.status === 404 || err.status === 405)) {
      args.io?.warn?.(
        'cloud does not expose /integrations/<provider>/status yet; falling back to the integrations list with ready-only matching.'
      );
      return await fetchIntegrationsForScope(args);
    }
    throw err;
  }
}

interface MatchOpts {
  expectedConfigKey?: string;
  serviceAccountName?: string;
}

function listHasConnectedProvider(
  body: unknown,
  provider: string,
  opts: MatchOpts = {}
): boolean {
  const candidates = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { integrations?: unknown }).integrations)
      ? (body as { integrations: unknown[] }).integrations
      : [];
  return candidates.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.provider !== provider) return false;
    if (opts.expectedConfigKey) {
      const rowConfigKey = readString(record, 'providerConfigKey');
      // If the row carries a providerConfigKey, enforce strict match.
      // If the field is missing entirely (older cloud that hasn't shipped
      // cloud#988), fall through to status-only matching — the cloud
      // server will still resolve the right config-key at dispatch time.
      if (rowConfigKey !== undefined && rowConfigKey !== opts.expectedConfigKey) {
        return false;
      }
    }
    if (opts.serviceAccountName) {
      const rowName = readString(record, 'name') ?? readString(record, 'serviceAccountName');
      if (rowName !== opts.serviceAccountName) return false;
    }
    return isConnectedStatus(record);
  });
}

function statusIsConnectedForSource(
  status: unknown,
  provider: string,
  source: IntegrationSource,
  expectedConfigKey?: string
): boolean {
  if (isIntegrationListResponse(status)) {
    return listHasConnectedProvider(status, provider, {
      ...(expectedConfigKey ? { expectedConfigKey } : {}),
      ...(source.kind === 'workspace_service_account'
        ? { serviceAccountName: source.name }
        : {})
    });
  }
  return statusMatchesExpectedConfigKey(status, expectedConfigKey)
    && isConnectedStatus(status);
}

function workspaceFallbackSource(
  source: IntegrationSource,
  allowWorkspaceFallback: boolean
): IntegrationSource | undefined {
  // Bare legacy personas parse to deployer_user, but older cloud deploy/connect
  // flows wrote and resolved default integrations at workspace scope. Try the
  // workspace row as a compatibility fallback after the deployer-user row is
  // absent or not ready. Explicitly authored deployer_user/workspace/service-
  // account sources still check their exact table and do not get widened.
  return allowWorkspaceFallback && source.kind === 'deployer_user'
    ? { kind: 'workspace' }
    : undefined;
}

function readConnectionId(status: unknown): string | undefined {
  return readString(status, 'connectionId')
    ?? readString(status, 'currentConnectionId');
}

function readProviderConfigKey(value: unknown): string | undefined {
  return readString(value, 'configKey')
    ?? readString(value, 'providerConfigKey')
    ?? readString(value, 'backendIntegrationId');
}

function statusMatchesConnectionId(status: unknown, expectedConnectionId: string | undefined): boolean {
  if (!expectedConnectionId) return true;
  const actual = readConnectionId(status);
  return actual === undefined || actual === expectedConnectionId;
}

function integrationAllowsWorkspaceFallback(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { __agentworkforceImplicitSource?: unknown }).__agentworkforceImplicitSource === true
  );
}

function isIntegrationListResponse(body: unknown): boolean {
  return Array.isArray(body)
    || Boolean(
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { integrations?: unknown }).integrations)
    );
}

function statusMatchesExpectedConfigKey(value: unknown, expectedConfigKey?: string): boolean {
  if (!expectedConfigKey || !value || typeof value !== 'object' || Array.isArray(value)) {
    return true;
  }
  const configKey =
    readProviderConfigKey(value);
  return configKey === undefined || configKey === expectedConfigKey;
}

/**
 * A provider counts as connected for deploy when the cloud confirms the
 * canonical credential row/backend connection exists. Top-level `ready` still
 * means initial sync/writeback are healthy, but OAuth completion can precede
 * that readiness and should not force deploy back through OAuth.
 *
 * When the status route is asked about a specific setup-session id, it returns
 * `connectionMatched:false` for a different final connection. Treat that as
 * not connected for the exact poll; the caller also performs a canonical
 * no-connectionId poll to reconcile successful OAuth completion.
 */
function isConnectedStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.connectionMatched === false) {
    return false;
  }
  const oauth = record.oauth;
  if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
    const oauthRecord = oauth as Record<string, unknown>;
    if (oauthRecord.connected === true) {
      return true;
    }
  }
  return record.status === 'ready'
    || record.state === 'ready'
    || record.ready === true;
}

/**
 * Resolver backed by `GET /api/v1/integrations/catalog`. The catalog is
 * pulled once on first lookup and cached for the lifetime of this
 * instance. Designed to be plugged into `ConnectAllInput.providerConfigKeys`
 * so the walker can pass a `expectedConfigKey` into `isConnected` calls.
 */
export function relayfileCatalogConfigKeyResolver(opts: {
  apiUrl: string;
  workspaceToken: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  io?: Pick<DeployIO, 'warn'>;
}): ProviderConfigKeyResolver {
  const fetchImpl = opts.fetch ?? fetch;
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  let cache: Promise<Map<string, string>> | null = null;

  const load = async (): Promise<Map<string, string>> => {
    const token = await resolveWorkspaceToken(opts.workspaceToken);
    const body = await requestJson(fetchImpl, `${apiUrl}/api/v1/integrations/catalog`, token);
    const entries = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as { providers?: unknown }).providers)
        ? (body as { providers: unknown[] }).providers
        : [];
    const map = new Map<string, string>();
    for (const entry of entries) {
      const id = readString(entry, 'id');
      const configKey = readString(entry, 'configKey') ?? readString(entry, 'defaultConfigKey');
      if (id && configKey) map.set(id, configKey);
    }
    return map;
  };

  return {
    async resolve(provider) {
      if (!cache) {
        cache = load().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          opts.io?.warn?.(
            `cloud integration catalog fetch failed (${message}); falling back to provider-name-only matching for this deploy`
          );
          cache = null;
          return new Map<string, string>();
        });
      }
      const map = await cache;
      return map.get(provider);
    }
  };
}

function readString(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function openBrowser(url: string): void {
  const command = platform() === 'darwin'
    ? 'open'
    : platform() === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // The URL is printed by the caller; browser launch is best-effort.
  });
  child.unref();
}

// --- Onboarding pickers ------------------------------------------------------
// Inputs annotated with `picker: { provider, resource }` in the persona name a
// value the operator should *choose* (a Slack user, a Linear team, …) rather
// than paste. After the provider is connected, the orchestrator fetches the
// candidate list from the cloud and prompts. This is a pure convenience layer:
// a picked value lands in the same `inputs` map an explicit `--input` would, so
// everything downstream is unchanged, and the step degrades gracefully (skip +
// warn) whenever it can't run — no value, no prompt, or an offline lookup.

/** One selectable candidate behind a {@link PersonaInputSpec.picker}. */
export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/** Resolves the candidate list for a persona input's `picker`. */
export interface IntegrationOptionsResolver {
  list(args: {
    workspace: string;
    provider: string;
    resource: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PickerOption[]>;
}

export const RELAYFILE_OPTIONS_MAX_PAGES = 200;

/**
 * Cloud-backed options resolver: `GET /api/v1/workspaces/<ws>/integrations/<provider>/options/<resource>`.
 * The cloud triggers the provider's Nango `list-*` action and returns a
 * normalized `{ options: [{ value, label, hint? }] }` body. Mirrors
 * {@link relayfileCatalogConfigKeyResolver}'s auth + transport.
 */
export function relayfileOptionsResolver(opts: {
  apiUrl: string;
  workspaceToken: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  io?: Pick<DeployIO, 'warn'>;
}): IntegrationOptionsResolver {
  const fetchImpl = opts.fetch ?? fetch;
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  return {
    async list({ workspace, provider, resource, query, cursor, limit }) {
      const token = await resolveWorkspaceToken(opts.workspaceToken);
      const baseUrl =
        `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspace)}` +
        `/integrations/${encodeURIComponent(provider)}/options/${encodeURIComponent(resource)}`;
      const options: PickerOption[] = [];
      const trimmedQuery = typeof query === 'string' && query.trim() ? query.trim() : undefined;
      let pageCursor = typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;
      let pages = 0;

      while (true) {
        const params = new URLSearchParams();
        if (trimmedQuery) params.set('query', trimmedQuery);
        if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) {
          params.set('limit', String(limit));
        }
        if (pageCursor) params.set('cursor', pageCursor);
        const queryString = params.toString();
        const url = queryString ? `${baseUrl}?${queryString}` : baseUrl;
        const body = await requestJson(fetchImpl, url, token);
        const raw = body && typeof body === 'object' ? (body as { options?: unknown }).options : undefined;
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            const value = readString(entry, 'value');
            if (!value) continue;
            const label = readString(entry, 'label') ?? value;
            const hint = readString(entry, 'hint');
            options.push({ value, label, ...(hint ? { hint } : {}) });
          }
        }

        pages += 1;
        const next = readString(body, 'nextCursor');
        if (!next) break;
        if (next === pageCursor) break;
        if (pages >= RELAYFILE_OPTIONS_MAX_PAGES) {
          opts.io?.warn?.(
            `cloud options list for ${provider}/${resource} exceeded ${RELAYFILE_OPTIONS_MAX_PAGES} pages; returning a truncated picker list`
          );
          break;
        }
        pageCursor = next;
      }
      return options;
    }
  };
}

export interface CollectPickerInputsInput {
  persona: PersonaSpec;
  workspace: string;
  io: DeployIO;
  resolver: IntegrationOptionsResolver;
  /** Inputs resolved so far (e.g. from `--input`). Not mutated. */
  inputs: Record<string, string>;
  /** Providers that were just connected — pickers for others are skipped. */
  connectedProviders: string[];
  env?: NodeJS.ProcessEnv;
  /** When true, never prompt; picker-annotated inputs are left to resolve normally. */
  noPrompt?: boolean;
}

/**
 * Walk the persona's picker-annotated inputs and, for any without a value yet,
 * prompt the operator to choose one. Returns a new inputs map (the original is
 * left untouched). Every failure mode is non-fatal: the input is simply left
 * unset so the runtime resolves it the usual way (env → default) or fails loudly
 * later, and the operator can always fall back to `--input NAME=…`.
 */
export async function collectPickerInputs(input: CollectPickerInputsInput): Promise<Record<string, string>> {
  const resolved: Record<string, string> = { ...input.inputs };
  const declared = input.persona.inputs ?? {};
  const env = input.env ?? process.env;
  const connected = new Set(input.connectedProviders);

  for (const [name, spec] of Object.entries(declared)) {
    const picker = spec.picker;
    if (!picker) continue;

    // Already have a value? An explicit --input or a set env var wins; never
    // override what the operator already chose.
    const envName = spec.env ?? name;
    const existing = resolved[name] ?? (env[envName] ?? undefined);
    if (existing !== undefined && existing.trim() !== '') continue;

    if (input.noPrompt) {
      // Non-interactive run: surface why the value is unset rather than
      // letting it silently fall through to env/default.
      input.io.warn(
        `skipping ${picker.provider} ${picker.resource} picker for input ${name} because --no-prompt is set; pass --input ${name}=… to set it`
      );
      continue;
    }
    if (!connected.has(picker.provider)) {
      // The provider wasn't connected this run (declared elsewhere, env path,
      // or skipped) — we can't reliably list it, so leave the input alone.
      continue;
    }

    let options: PickerOption[];
    try {
      options = await input.resolver.list({
        workspace: input.workspace,
        provider: picker.provider,
        resource: picker.resource
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.io.warn(
        `could not list ${picker.provider} ${picker.resource} for input ${name} (${message}); pass --input ${name}=… to set it`
      );
      continue;
    }

    if (options.length === 0) {
      input.io.warn(
        `no ${picker.provider} ${picker.resource} available for input ${name}; pass --input ${name}=… to set it`
      );
      continue;
    }

    const label = spec.description ? `${name} — ${spec.description}` : name;
    const chosen = await selectOption(input.io, `Select ${label}`, options);
    if (chosen) resolved[name] = chosen;
  }

  return resolved;
}

/**
 * Render a chooser for `options` and return the picked value. Uses the IO's
 * native `select` when available (rich CLIs); otherwise falls back to a
 * numbered prompt that also accepts a pasted raw value.
 */
async function selectOption(io: DeployIO, question: string, options: PickerOption[]): Promise<string | undefined> {
  if (io.select) {
    return io.select(question, options);
  }
  io.info(`${question}:`);
  options.forEach((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : '';
    io.info(`  ${index + 1}) ${option.label}${hint}  [${option.value}]`);
  });
  const answer = (await io.prompt(`Enter 1-${options.length} (or paste a value)`, { defaultValue: '1' })).trim();
  if (answer === '') return options[0]?.value;
  // Only a pure decimal string is an index — `String(index) === answer` rejects
  // pasted ids like `1abc` (which parseInt would coerce to 1), matching the
  // terminal IO's select(). Anything else is treated as a pasted raw value.
  const index = Number.parseInt(answer, 10);
  if (String(index) === answer && index >= 1 && index <= options.length) {
    return options[index - 1]?.value;
  }
  return answer;
}
