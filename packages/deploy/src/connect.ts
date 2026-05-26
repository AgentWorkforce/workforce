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
    async connect({ workspace, provider, source }) {
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
        scope: scopeRequest(effectiveSource)
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
        // Scope the status poll to the same table the connect-session
        // wrote into. Older clouds ignore the param and read from
        // workspace_integrations (today's behavior).
        const scopeParam = effectiveSource.kind;
        statusUrl.searchParams.set('scope', scopeParam);
        if (effectiveSource.kind === 'workspace_service_account') {
          statusUrl.searchParams.set('serviceAccountName', effectiveSource.name);
        }
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
      const result = await input.integrations.connect({
        workspace: input.workspace,
        provider,
        source
      });
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
 * A row counts as "connected" when the cloud's derived state represents a
 * live OAuth grant, even if Nango's initial sync hasn't finished. The cloud
 * derives `status` from `initialSync + writeback` and emits one of:
 *
 *   - `ready`     — sync complete, writeback healthy. Fully usable.
 *   - `pending`   — OAuth grant exists, sync queued (the gap between OAuth
 *                   completion and sync start). Persona can use it for
 *                   writes immediately; reads will see data once sync runs.
 *   - `syncing`   — initial sync running. Same operational status as `pending`
 *                   from the persona's perspective.
 *   - `degraded`  — sync complete but writeback lagging or paused. Connection
 *                   still works; reading at-rest data is fine; new writes may
 *                   queue but won't fail.
 *   - `error`     — sync failed or writeback errored. Treat as not-connected
 *                   so the user re-runs OAuth (or fixes the upstream cause).
 *
 * The preflight accepts everything except `error` and missing rows. The
 * previous implementation accepted only `ready`, which forced users to wait
 * for the initial sync to complete between `agentworkforce login` and their
 * first deploy — every fresh integration sat in `pending`/`syncing` for a
 * few minutes and tripped the "not connected" branch.
 *
 * Legacy fields (`connected`, `active`, `state`, `ready: true`, `oauth.connected`)
 * are kept for compatibility with older cloud surfaces and the env resolver.
 */
function isConnectedStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === 'connected'
    || record.status === 'active'
    || record.status === 'ready'
    || record.status === 'pending'
    || record.status === 'syncing'
    || record.status === 'degraded'
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
