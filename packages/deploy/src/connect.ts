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
  }): Promise<boolean>;
  /** Run the browser-based OAuth flow and resolve when the user finishes. */
  connect(args: { workspace: string; provider: string }): Promise<{ connectionId: string }>;
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
    async isConnected({ workspace, provider, source, expectedConfigKey }) {
      const workspaceId = workspace || opts.workspaceId;
      const token = await resolveWorkspaceToken(opts.workspaceToken);
      const effectiveSource: IntegrationSource = source ?? { kind: 'deployer_user' };

      const list = await fetchIntegrationsForScope({
        fetchImpl,
        apiUrl,
        token,
        workspaceId,
        source: effectiveSource,
        io
      });
      return listHasConnectedProvider(list, provider, {
        ...(expectedConfigKey ? { expectedConfigKey } : {}),
        ...(effectiveSource.kind === 'workspace_service_account'
          ? { serviceAccountName: effectiveSource.name }
          : {})
      });
    },
    async connect({ workspace, provider }) {
      const workspaceId = workspace || opts.workspaceId;
      const token = await resolveWorkspaceToken(opts.workspaceToken);
      const session = await requestJson(fetchImpl, `${apiUrl}/api/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/integrations/connect-session`, token, {
        method: 'POST',
        body: JSON.stringify({ allowedIntegrations: [provider] })
      });
      const sessionUrl = readString(session, 'sessionUrl')
        ?? readString(session, 'connectLink')
        ?? readString(session, 'url');
      if (!sessionUrl) {
        throw new Error(`integration ${provider} connect-session did not return a session URL`);
      }
      const sessionId = readString(session, 'sessionId') ?? readString(session, 'connectionId');
      io?.info(`Connecting ${provider}: opening ${sessionUrl}`);
      try {
        await (opts.openUrl ?? openBrowser)(sessionUrl);
      } catch (err) {
        io?.warn?.(`Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`);
      }

      const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
      while (Date.now() < deadline) {
        await sleepImpl(opts.pollIntervalMs ?? 2_000);
        const statusUrl = new URL(`${apiUrl}/api/v1/workspaces/${encodeURIComponent(
          workspaceId
        )}/integrations/${encodeURIComponent(provider)}/status`);
        if (sessionId) statusUrl.searchParams.set('connectionId', sessionId);
        const status = await requestJson(
          fetchImpl,
          statusUrl.toString(),
          await resolveWorkspaceToken(opts.workspaceToken)
        );
        if (isConnectedStatus(status)) {
          const connectionId = readString(status, 'connectionId')
            ?? readString(status, 'currentConnectionId')
            ?? sessionId
            ?? provider;
          io?.info(`${provider} connected.`);
          return { connectionId };
        }
      }

      throw new Error(
        `Timed out waiting for ${provider} OAuth to complete. Re-run \`agentworkforce deploy ...\` after connecting.`
      );
    }
  };
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

  for (const provider of Object.keys(integrations)) {
    const integrationEntry = integrations[provider] ?? {};
    const source: IntegrationSource = integrationEntry.source ?? { kind: 'deployer_user' };
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

    if (connected) {
      input.io.info(`integrations.${provider}: already connected`);
      outcomes.push({ provider, status: 'already-connected' });
      continue;
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
        if (connected) {
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

    if (input.noPrompt) {
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

    if (input.noConnect) {
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

    const shouldConnect = await input.io.confirm(
      `Connect ${provider} now? (opens browser)`,
      { defaultValue: true }
    );
    if (!shouldConnect) {
      outcomes.push({ provider, status: 'skipped', message: 'user declined to connect' });
      continue;
    }

    try {
      const result = await input.integrations.connect({ workspace: input.workspace, provider });
      input.io.info(`integrations.${provider}: connected (${result.connectionId})`);
      outcomes.push({ provider, status: 'connected-now' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.io.error(`integrations.${provider}: connect failed: ${message}`);
      outcomes.push({ provider, status: 'failed', message });
    }
  }

  // Track the subscription provider only when this deploy actually
  // connected one — already-connected cases stay logged but do not
  // leak a sentinel string up to callers reading `subscriptionProvider`.
  let subscriptionProvider: string | undefined;
  if (input.persona.useSubscription) {
    if (!input.subscription) {
      throw new Error(
        'persona has useSubscription:true but no subscription resolver was supplied to the deploy orchestrator'
      );
    }
    const isConn = await input.subscription
      .isConnected({ workspace: input.workspace })
      .catch(() => false);
    if (!isConn) {
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
      const result = await input.subscription.connect({ workspace: input.workspace });
      subscriptionProvider = result.provider;
      input.io.info(`subscription: connected (${result.provider})`);
    } else {
      input.io.info('subscription: already connected');
    }
  }

  return {
    outcomes,
    ...(subscriptionProvider ? { subscriptionProvider } : {})
  };
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
      ...(expectedConfigKey ? { expectedConfigKey } : {})
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      onFailure(message);
      input.io.warn(`failed to check connection status for ${provider}: ${message}`);
      return false;
    });
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
    throw new Error(
      'cloud integration request failed: unauthorized. Your active workspace session is invalid or expired. Run `agentworkforce login --workspace <id-or-slug>` to refresh, then retry.'
    );
  }
  if (res.status === 403) {
    throw new Error(
      'cloud integration request failed: forbidden. The active account is not authorized for this workspace. Run `agentworkforce login --workspace <id-or-slug>` against an account with access, then retry.'
    );
  }
  if (!res.ok) {
    throw new Error(`cloud integration request failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
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
      const message = err instanceof Error ? err.message : String(err);
      if (/\b404\b/.test(message) || /\b405\b/.test(message)) {
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

/**
 * A row counts as "connected" only when the cloud's derived state is
 * affirmatively healthy. The previous implementation also accepted "any
 * truthy connectionId" as a yes, which produced false positives whenever a
 * stale row was left behind by an abandoned OAuth attempt. The cloud now
 * derives `status` from `initialSync + writeback` (see
 * `cloud/packages/web/app/api/v1/workspaces/[workspaceId]/integrations/route.ts:62`),
 * so trusting that field is both correct and sufficient.
 */
function isConnectedStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === 'connected'
    || record.status === 'active'
    || record.status === 'ready'
    || record.state === 'connected'
    || record.state === 'ready'
    || record.ready === true
    || (record.oauth !== null
      && typeof record.oauth === 'object'
      && (record.oauth as { connected?: unknown }).connected === true);
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
