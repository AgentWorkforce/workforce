import type { PersonaSpec } from '@agentworkforce/persona-kit';
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
  /** Is the provider already linked to the workspace? */
  isConnected(args: { workspace: string; provider: string }): Promise<boolean>;
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
  io: DeployIO;
  integrations: IntegrationConnectResolver;
  /** Required only when persona.useSubscription is true. */
  subscription?: ProviderSubscriptionResolver;
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
 *   - not connected + noConnect=true → fails the deploy with a clear message
 *   - not connected + noConnect=false → prompts; on yes runs `connect`,
 *     on no marks `skipped`. The orchestrator decides what to do with
 *     `skipped` outcomes (today: fails the deploy at the call site).
 */
export async function connectIntegrations(input: ConnectAllInput): Promise<ConnectAllResult> {
  const integrations = input.persona.integrations ?? {};
  const outcomes: IntegrationConnectOutcome[] = [];

  for (const provider of Object.keys(integrations)) {
    const connected = await input.integrations
      .isConnected({ workspace: input.workspace, provider })
      .catch((err) => {
        input.io.warn(
          `failed to check connection status for ${provider}: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      });

    if (connected) {
      input.io.info(`integrations.${provider}: already connected`);
      outcomes.push({ provider, status: 'already-connected' });
      continue;
    }

    if (input.noConnect) {
      input.io.error(
        `integrations.${provider}: not connected, and --no-connect was passed`
      );
      outcomes.push({
        provider,
        status: 'failed',
        message: 'not connected (--no-connect was set)'
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
