import { readFile } from 'node:fs/promises';
import {
  CloudApiClient,
  connectProvider,
  defaultApiUrl,
  readStoredAuth,
  refreshStoredAuth,
  type StoredAuth
} from '@agent-relay/cloud';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import type {
  ModeLaunchInput,
  ModeLaunchHandle,
  ModeLauncher
} from '../../types.js';
import {
  resolveWorkspaceToken,
  type WorkspaceAuthToken
} from '../../login.js';

const BUILD_YOUR_OWN_CLOUD_DOCS_URL = 'https://docs.agentworkforce.com/deploy/build-your-own-cloud';
const USER_AGENT = 'workforce-deploy';
const MAX_ATTEMPTS = 3;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

type CloudDeployStatus = 'ready' | 'starting' | 'active' | 'failed' | 'cancelled';
export type HarnessSource = 'plan' | 'byok' | 'oauth';
type OnExistsChoice = 'update' | 'destroy' | 'cancel';

export interface CloudSubscriptionReadyResult {
  provider: string;
  credentialSelections?: Record<string, string>;
}

export interface CloudRunHandle extends ModeLaunchHandle {
  agentId: string;
  deploymentId: string;
  status: CloudDeployStatus;
}

interface CloudDeployResponse {
  agentId?: unknown;
  workspaceId?: unknown;
  status?: unknown;
  deploymentId?: unknown;
}

interface CloudAgentStatusResponse {
  id?: unknown;
  agentId?: unknown;
  status?: unknown;
}

/**
 * Shape of `GET /api/v1/cloud-agents` on the cloud side.
 *
 * Each entry represents one (user, workspace, harness) row in the
 * `cloud_agents` table; `status === 'connected'` means the harness OAuth
 * completion stored a usable credential in S3 (see cloud's
 * `cli/auth/complete` route handler).
 */
interface CloudAgentsListResponse {
  agents?: unknown;
}

interface CloudAgentEntry {
  harness?: unknown;
  status?: unknown;
  credentialStoredAt?: unknown;
  id?: unknown;
  isActive?: unknown;
  is_active?: unknown;
}

interface ExistingAgentResponse {
  agent?: unknown;
  agents?: unknown;
}

interface ExistingAgent {
  id: string;
  status?: string;
}

type CloudApiClientLike = Pick<CloudApiClient, 'fetch'>;

type CloudCredentialDeps = {
  readStoredAuth: typeof readStoredAuth;
  refreshStoredAuth: typeof refreshStoredAuth;
  connectProvider: typeof connectProvider;
  createCloudApiClient(auth: StoredAuth, apiUrl: string): CloudApiClientLike;
};

const defaultCloudCredentialDeps: CloudCredentialDeps = {
  readStoredAuth,
  refreshStoredAuth,
  connectProvider,
  createCloudApiClient(auth, apiUrl) {
    return new CloudApiClient({
      apiUrl,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      accessTokenExpiresAt: auth.accessTokenExpiresAt
    });
  }
};

let cloudCredentialDeps = defaultCloudCredentialDeps;

export function configureCloudCredentialDepsForTest(
  overrides: Partial<CloudCredentialDeps>
): () => void {
  const previous = cloudCredentialDeps;
  cloudCredentialDeps = { ...cloudCredentialDeps, ...overrides };
  return () => {
    cloudCredentialDeps = previous;
  };
}

/**
 * Cloud-hosted deploy mode. Uploads the deploy-ready persona bundle to a
 * workforce-compatible cloud endpoint. The implementation is intentionally
 * OSS-generic: callers may point at any compatible runtime with
 * `--cloud-url`, `WORKFORCE_CLOUD_URL`, or `persona.cloud.deployUrl`; the
 * production AgentRelay URL is only the final default.
 */
export const cloudLauncher: ModeLauncher = {
  async launch(input: ModeLaunchInput): Promise<CloudRunHandle> {
    const cloudUrl = resolveCloudUrl(input);
    const noPrompt = isNoPrompt(input);
    const auth = input.workspaceToken
      ? { token: input.workspaceToken }
      : await resolveWorkspaceToken({
          workspace: input.workspace,
          cloudUrl,
          io: input.io,
          noPrompt
        });

    const credentialSelections = input.credentialSelections ?? await ensureHarnessReady({
      cloudUrl,
      workspaceId: input.workspace,
      token: auth.token,
      persona: input.persona,
      io: input.io,
      noPrompt,
      harnessSource: input.harnessSource,
      byokKey: input.byokKey,
      reconnectProviders: input.reconnectProviders
    });

    const existingPersona = await handleExistingPersona({
      cloudUrl,
      workspaceId: input.workspace,
      token: auth.token,
      personaId: input.persona.id,
      io: input.io,
      noPrompt,
      onExists: input.onExists
    });
    if (existingPersona.cancelled) {
      return {
        id: existingPersona.agentId,
        agentId: existingPersona.agentId,
        deploymentId: 'cancelled',
        status: 'cancelled',
        async stop() {
          /* no-op: user chose not to change the existing hosted persona. */
        },
        done: Promise.resolve({ code: 0 })
      };
    }

    const body = JSON.stringify({
      persona: input.persona,
      // Top-level agent listener spec (triggers/schedules/watch). The cloud
      // reads subscriptions from here now that they no longer live on the
      // persona. Distinct from `bundle.agent`, which is the esbuilt handler.
      agent: input.agent,
      bundle: {
        runner: await readFile(input.bundle.runnerPath, 'utf8'),
        agent: await readFile(input.bundle.bundlePath, 'utf8'),
        packageJson: JSON.parse(await readFile(input.bundle.packageJsonPath, 'utf8')) as unknown
      },
      // Keep both casings until all cloud deploy endpoints converge; older
      // previews read snake_case, while current routes read camelCase.
      credentialSelections,
      credential_selections: credentialSelections,
      inputs: input.inputs ?? readInputsOverride()
    });

    const endpoint = deploymentsEndpoint(cloudUrl, input.workspace);
    input.io.info(`cloud: deploying persona bundle to ${cloudUrl}`);
    const deployBody = await requestJsonWithRetry<CloudDeployResponse>(
      endpoint,
      {
        method: 'POST',
        headers: jsonHeaders(auth.token),
        body
      },
      { action: 'cloud deploy' }
    );

    const agentId = expectString(deployBody.agentId, 'agentId');
    const deploymentId = expectString(deployBody.deploymentId, 'deploymentId');
    const initialStatus = expectStatus(deployBody.status);
    input.io.info(`cloud: deployment ${deploymentId} created for agent ${agentId}`);

    let stopping = false;
    const done = (async (): Promise<{ code: number }> => {
      if (initialStatus === 'ready' || initialStatus === 'active') return { code: 0 };
      if (initialStatus === 'failed') return { code: 1 };

      try {
        const finalStatus = await pollAgentStatus({
          cloudUrl,
          workspaceId: input.workspace,
          agentId,
          token: auth.token,
          io: input.io,
          onLog: input.onLog
        });
        return { code: finalStatus === 'ready' || finalStatus === 'active' ? 0 : 1 };
      } catch (err) {
        if (!stopping) {
          input.io.error(
            `cloud: status polling failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { code: 1 };
      }
    })();

    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await deleteAgent({
        cloudUrl,
        workspaceId: input.workspace,
        agentId,
        token: auth.token,
        action: 'cloud stop'
      });
    };

    return {
      id: agentId,
      agentId,
      deploymentId,
      status: initialStatus,
      stop,
      done
    };
  }
};

function deploymentsEndpoint(cloudUrl: string, workspaceId: string): string {
  return `${cloudUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments`;
}

function resolveCloudUrl(input: ModeLaunchInput): string {
  const fromInput = input.cloudUrl?.trim();
  const fromEnv = process.env.WORKFORCE_DEPLOY_CLOUD_URL?.trim()
    || process.env.WORKFORCE_CLOUD_URL?.trim();
  const fromPersona = readPersonaCloudDeployUrl(input.persona);
  const raw = fromInput || fromEnv || fromPersona || defaultApiUrl();
  const resolved = normalizeCloudUrl(raw);
  if (resolved !== normalizeCloudUrl(defaultApiUrl())) {
    input.io.info(
      `cloud: using custom cloud URL ${resolved}. Build your own cloud docs: ${BUILD_YOUR_OWN_CLOUD_DOCS_URL}`
    );
  }
  return resolved;
}

function isNoPrompt(input: ModeLaunchInput): boolean {
  if (input.noPrompt) return true;
  const raw = process.env.WORKFORCE_DEPLOY_NO_PROMPT?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

async function ensureHarnessReady(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  harnessSource?: HarnessSource;
  byokKey?: string;
  reconnectProviders?: readonly string[];
}): Promise<Record<string, string>> {
  // Pure handler personas declare no harness (the bundled handler never calls
  // ctx.harness.run — it orchestrates via ctx.workflow.run / integration
  // clients). There's no harness inference to bill, so skip credential
  // provisioning entirely.
  if (!args.persona.harness) {
    args.io.info('cloud: persona declares no harness; skipping harness credential setup');
    return {};
  }
  const source = await resolveHarnessSource(args);
  const modelProvider = deriveModelProvider(args.persona);
  if (source === 'plan') {
    const credentialId = await saveProviderCredential({
      cloudUrl: args.cloudUrl,
      workspaceId: args.workspaceId,
      token: args.token,
      modelProvider,
      authType: 'relay_managed'
    });
    args.io.info(`cloud: using workforce plan credentials for ${args.persona.harness}`);
    return { [modelProvider]: credentialId };
  }

  if (source === 'byok') {
    const key = await resolveByokKey(args);
    const credentialId = await saveProviderCredential({
      cloudUrl: args.cloudUrl,
      workspaceId: args.workspaceId,
      token: args.token,
      modelProvider,
      authType: 'byo_api_key',
      apiKey: key
    });
    args.io.info(`cloud: using BYOK credentials for ${args.persona.harness}`);
    return { [modelProvider]: credentialId };
  }

  await ensureHarnessOauth(args);
  return resolveOauthCredentialSelections(args);
}

async function resolveHarnessSource(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  harnessSource?: HarnessSource;
  byokKey?: string;
}): Promise<HarnessSource> {
  if (args.harnessSource) return args.harnessSource;
  const fromEnv = process.env.WORKFORCE_DEPLOY_HARNESS_SOURCE?.trim();
  if (fromEnv) return expectHarnessSource(fromEnv);

  const available = await isHarnessOauthConnected(args);
  if (available) return 'oauth';

  if (args.noPrompt) {
    throw new Error(
      `cloud: ${args.persona.harness} credentials are not connected. Re-run with --harness-source plan|byok|oauth, set WORKFORCE_DEPLOY_HARNESS_SOURCE, or run without --no-prompt.`
    );
  }

  const answer = await args.io.prompt(
    `${args.persona.harness} credentials are not connected. Choose harness source (plan/byok/oauth)`,
    { defaultValue: 'plan' }
  );
  return expectHarnessSource(answer);
}

/**
 * Check whether the user already has a connected harness credential in
 * cloud for this persona's model provider.
 *
 * Cloud surfaces this via `GET /api/v1/cloud-agents`, which returns one
 * row per (user, workspace, harness) — `harness` is the provider key
 * ("anthropic", "openai", …) and `status === 'connected'` means the
 * OAuth completion route successfully stored a credential.
 *
 * We previously called `/api/v1/users/me/provider_credentials?model_provider=...`,
 * which doesn't exist on cloud at all (the route was never built). That
 * 404 made every deploy with `--no-prompt` fail with "credentials are
 * not connected" even when they were — see workforce#118 follow-up.
 */
async function isHarnessOauthConnected(args: {
  cloudUrl: string;
  persona: PersonaSpec;
}): Promise<boolean> {
  const body = await fetchCloudAgents(args.cloudUrl);
  if (!body) return false;
  return hasConnectedHarness(body, deriveModelProvider(args.persona));
}

/**
 * Fetch the `/api/v1/cloud-agents` list, or `null` when there is no usable
 * stored auth or the route doesn't exist on the target cloud (404/405).
 */
async function fetchCloudAgents(cloudUrl: string): Promise<CloudAgentsListResponse | null> {
  const auth = await readUsableCloudAuth(cloudUrl);
  if (!auth) return null;
  const client = cloudCredentialDeps.createCloudApiClient(auth, cloudUrl);
  const res = await client.fetch('/api/v1/cloud-agents', {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT }
  });
  if (res.status === 404 || res.status === 405) return null;
  if (res.status === 401) {
    throw new Error('cloud harness check failed: unauthorized. Run `agentworkforce login` and retry.');
  }
  if (!res.ok) {
    throw new Error(`cloud harness check failed: ${res.status} ${await responseExcerpt(res)}`);
  }
  return (await res.json()) as CloudAgentsListResponse;
}

/**
 * Stamp `credentialSelections` for the oauth harness source so cloud's
 * runtime can configure `ctx.llm` from the deployment. The byok/plan legs
 * already stamp the credential they create; an oauth deploy without a
 * selection leaves the deployment with empty selections and every fire
 * stubs ctx.llm — workforce#196.
 *
 * Provider split is deliberate:
 * - anthropic: the OAuth completion route upserts a `provider_credentials`
 *   row, and cloud resolves it to a runtime env credential — stamp it.
 * - openai (and anything else): ChatGPT/codex OAuth tokens are harness-only;
 *   cloud rejects them for runtime env, so stamping the persona-family
 *   credential would turn the ctx.llm stub into a failed delivery. Stamp a
 *   connected anthropic credential instead when one exists (the runtime
 *   adapts the model family), else print the actionable alternative.
 */
async function resolveOauthCredentialSelections(args: {
  cloudUrl: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
}): Promise<Record<string, string>> {
  const provider = deriveModelProvider(args.persona);
  const body = await fetchCloudAgents(args.cloudUrl);
  if (provider !== 'anthropic') {
    // Cross-provider fallback: the runtime's credential pick already
    // prefers the persona's model family but falls back to whatever
    // provider env IS present, swapping in that family's default model
    // (cloud-llm selectCredential/resolveModel). So when the persona
    // family can't back ctx.llm (codex/ChatGPT OAuth is harness-only), a
    // connected anthropic credential is the honest deploy-time encoding
    // of what the runtime would do anyway.
    const anthropicId = body ? findConnectedHarnessCredentialId(body, 'anthropic') : null;
    if (anthropicId) {
      args.io.info(
        `cloud: ${provider} subscriptions are harness-only and cannot back ctx.llm; ` +
          'stamping your connected anthropic credential instead (the runtime adapts the model family).'
      );
      return { anthropic: anthropicId };
    }
    args.io.info(
      `cloud: ${provider} subscriptions are harness-only and cannot back ctx.llm; ` +
        'use --harness-source byok with a platform API key, or connect an anthropic credential.'
    );
    return {};
  }
  const credentialId = body ? findConnectedHarnessCredentialId(body, provider) : null;
  if (!credentialId) {
    args.io.info(
      `cloud: no connected ${provider} credential row found; deploying without a ctx.llm credential selection.`
    );
    return {};
  }
  args.io.info(`cloud: selected connected ${provider} credential for ctx.llm`);
  return { [provider]: credentialId };
}

async function resolveByokKey(args: {
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  byokKey?: string;
}): Promise<string> {
  if (args.byokKey?.trim()) return args.byokKey.trim();
  const fromEnv = process.env.WORKFORCE_DEPLOY_BYOK_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (args.noPrompt) {
    throw new Error(
      `cloud: --harness-source byok requires --byok-key or WORKFORCE_DEPLOY_BYOK_KEY for ${args.persona.harness}`
    );
  }
  const answer = await args.io.prompt(`API key for ${args.persona.harness}`);
  if (!answer.trim()) {
    throw new Error(`cloud: missing BYOK API key for ${args.persona.harness}`);
  }
  return answer.trim();
}

async function ensureHarnessOauth(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  reconnectProviders?: readonly string[];
}): Promise<void> {
  const reconnect = harnessReconnectRequested(args.reconnectProviders, args.persona);
  const connected = await isHarnessOauthConnected(args);
  // Cloud reports a credential row as `connected` even when its stored OAuth
  // token was revoked server-side (cloud never re-validates it), so a plain
  // redeploy can never refresh a dead harness credential. `--reconnect
  // <provider>` forces the connect flow to re-run and overwrite the stored
  // token — the escape hatch for codex/ChatGPT refresh-token rotation.
  if (connected && !reconnect) {
    args.io.info(`cloud: ${args.persona.harness} credentials already connected`);
    return;
  }
  if (args.noPrompt) {
    throw new Error(
      connected
        ? `cloud: --reconnect ${deriveModelProvider(args.persona)} opens a browser connect flow; re-run without --no-prompt.`
        : `cloud: ${args.persona.harness} OAuth credentials are not connected. Run without --no-prompt or choose --harness-source plan/byok.`
    );
  }
  if (connected) {
    args.io.info(
      `cloud: reconnect requested; opening a fresh ${args.persona.harness} connection flow (replaces the stored credential)`
    );
  } else {
    const ok = await args.io.confirm(
      `Connect ${args.persona.harness} credentials now? (opens browser)`,
      { defaultValue: true }
    );
    if (!ok) {
      throw new Error(`cloud: ${args.persona.harness} credentials are required for deploy`);
    }
  }
  const modelProvider = deriveModelProvider(args.persona);
  await cloudCredentialDeps.connectProvider({
    provider: modelProvider,
    apiUrl: args.cloudUrl,
    language: 'typescript',
    io: {
      log: (...parts: unknown[]) => args.io.info(parts.map(String).join(' ')),
      error: (...parts: unknown[]) => args.io.error(parts.map(String).join(' '))
    }
  });
  await pollUntil(
    () => isHarnessOauthConnected(args),
    `timed out waiting for ${args.persona.harness} OAuth credentials`
  );
  args.io.info(`cloud: ${args.persona.harness} credentials connected`);
}

/**
 * Whether the user asked (via `--reconnect <provider>`) to force a fresh
 * connection for this persona's harness LLM credential even when cloud already
 * reports one connected. Matches either the resolved model provider
 * ("openai"/"anthropic") or the harness name ("codex"/"claude") so both
 * `--reconnect openai` and `--reconnect codex` work.
 */
function harnessReconnectRequested(
  reconnectProviders: readonly string[] | undefined,
  persona: PersonaSpec
): boolean {
  if (!reconnectProviders?.length) return false;
  const wanted = new Set(
    reconnectProviders.map((p) => p.trim().toLowerCase()).filter(Boolean)
  );
  if (wanted.size === 0) return false;
  return [deriveModelProvider(persona), persona.harness]
    .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    .some((key) => wanted.has(key.trim().toLowerCase()));
}

export function validateCloudSubscriptionSupport(args: {
  persona: PersonaSpec;
  harnessSource?: HarnessSource;
}): void {
  resolveSubscriptionHarnessSource(args);
}

export async function ensureCloudSubscriptionReady(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  harnessSource?: HarnessSource;
  byokKey?: string;
  reconnectProviders?: readonly string[];
}): Promise<CloudSubscriptionReadyResult> {
  const source = resolveSubscriptionHarnessSource(args);
  const provider = deriveModelProvider(args.persona);

  if (source === 'byok') {
    const key = await resolveByokKey(args);
    const credentialId = await saveProviderCredential({
      cloudUrl: args.cloudUrl,
      workspaceId: args.workspaceId,
      token: args.token,
      modelProvider: provider,
      authType: 'byo_api_key',
      apiKey: key
    });
    args.io.info(`subscription: using BYOK credentials for ${provider}`);
    return {
      provider,
      credentialSelections: { [provider]: credentialId }
    };
  }

  await ensureSubscriptionOauth(args);
  const credentialSelections = await resolveOauthCredentialSelections(args);
  return Object.keys(credentialSelections).length > 0
    ? { provider, credentialSelections }
    : { provider };
}

function resolveSubscriptionHarnessSource(args: {
  persona: PersonaSpec;
  harnessSource?: HarnessSource;
}): Exclude<HarnessSource, 'plan'> {
  const rawSource = args.harnessSource ?? process.env.WORKFORCE_DEPLOY_HARNESS_SOURCE?.trim();
  const source = rawSource ? expectHarnessSource(rawSource) : 'oauth';
  if (source === 'plan') {
    throw new Error(
      `persona "${args.persona.id}" sets useSubscription:true; use --harness-source oauth to connect your LLM provider, ` +
        'use --harness-source byok with --byok-key, or remove useSubscription to use workforce-billed inference.'
    );
  }
  return source;
}

async function ensureSubscriptionOauth(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  persona: PersonaSpec;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  reconnectProviders?: readonly string[];
}): Promise<void> {
  const provider = deriveModelProvider(args.persona);
  const reconnect = harnessReconnectRequested(args.reconnectProviders, args.persona);
  const connected = await isHarnessOauthConnected(args);
  // See ensureHarnessOauth: a `connected` row can hold a revoked token, so
  // `--reconnect <provider>` forces a fresh connect that overwrites it.
  if (connected && !reconnect) {
    args.io.info(`subscription: ${provider} credentials already connected`);
    return;
  }
  if (args.noPrompt) {
    throw new Error(
      connected
        ? `cloud: --reconnect ${provider} opens a browser connect flow; re-run without --no-prompt.`
        : `persona "${args.persona.id}" sets useSubscription:true but ${provider} credentials are not connected. ` +
            'Run without --no-prompt to connect them, pass --harness-source byok with --byok-key, or remove useSubscription to use workforce-billed inference.'
    );
  }
  if (connected) {
    args.io.info(
      `subscription: reconnect requested; opening a fresh ${provider} connection flow (replaces the stored credential)`
    );
  } else {
    const ok = await args.io.confirm(
      `Connect ${provider} credentials for useSubscription now? (opens browser)`,
      { defaultValue: true }
    );
    if (!ok) {
      throw new Error('user declined the subscription provider connect; deploy aborted');
    }
  }
  await cloudCredentialDeps.connectProvider({
    provider,
    apiUrl: args.cloudUrl,
    language: 'typescript',
    io: {
      log: (...parts: unknown[]) => args.io.info(parts.map(String).join(' ')),
      error: (...parts: unknown[]) => args.io.error(parts.map(String).join(' '))
    }
  });
  await pollUntil(
    () => isHarnessOauthConnected(args),
    `timed out waiting for ${provider} OAuth credentials`
  );
  args.io.info(`subscription: ${provider} credentials connected`);
}

async function handleExistingPersona(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  personaId: string;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  onExists?: OnExistsChoice;
}): Promise<{ cancelled: false } | { cancelled: true; agentId: string }> {
  const existing = await findExistingAgent(args);
  if (!existing) return { cancelled: false };
  const choice = await resolveOnExists(args);
  if (choice === 'cancel') {
    args.io.info(`cloud: deploy cancelled because persona ${args.personaId} already exists`);
    return { cancelled: true, agentId: existing.id };
  }
  if (choice === 'update') {
    args.io.info(`cloud: updating existing persona ${args.personaId}`);
    return { cancelled: false };
  }

  args.io.info(`cloud: destroying existing persona ${args.personaId} before deploy`);
  await deleteAgent({
    cloudUrl: args.cloudUrl,
    workspaceId: args.workspaceId,
    token: args.token,
    agentId: existing.id,
    action: 'cloud existing persona destroy'
  });
  return { cancelled: false };
}

/**
 * Look up a deployed-persona row in the workspace, if any.
 *
 * We call the workspace deployments list — added in cloud#580 — and
 * filter client-side. Why not `/workspaces/{ws}/agents`? That route is
 * a dashboard proxy to an external gateway, requires session auth
 * (cookie), and returns 403 for the cli:auth Bearer tokens this CLI
 * uses. The deployments list is the actual `agents` table reader and
 * accepts cli:auth scope.
 *
 * Why no `?personaId=` server-side filter? `agents.personaId` is the
 * persona's UUID, not its slug. The CLI only knows the persona's slug
 * (the `id` field in the local persona JSON). Sending the slug as
 * `personaId=` makes cloud's drizzle `eq(agents.personaId, slug)`
 * predicate throw on the UUID cast → 500. The list is bounded to one
 * workspace's worth of agents (typically dozens), so a client-side
 * filter on `deployedName` (which cloud derives from
 * `persona.slug || persona.name || persona.id`) is the right tradeoff
 * until cloud teaches the filter to accept slugs.
 */
async function findExistingAgent(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  personaId: string;
}): Promise<ExistingAgent | null> {
  const url = `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    args.workspaceId
  )}/deployments`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${args.token}`,
      'user-agent': USER_AGENT
    }
  });
  if (res.status === 404 || res.status === 405) return null;
  if (res.status === 401) {
    throw new Error('cloud existing persona check failed: unauthorized. Run `agentworkforce login` and retry.');
  }
  if (!res.ok) {
    throw new Error(`cloud existing persona check failed: ${res.status} ${await responseExcerpt(res)}`);
  }
  return parseExistingAgent((await res.json()) as ExistingAgentResponse, args.personaId);
}

async function resolveOnExists(args: {
  personaId: string;
  io: ModeLaunchInput['io'];
  noPrompt: boolean;
  onExists?: OnExistsChoice;
}): Promise<OnExistsChoice> {
  if (args.onExists) return args.onExists;
  const fromEnv = process.env.WORKFORCE_DEPLOY_ON_EXISTS?.trim();
  if (fromEnv) return expectOnExistsChoice(fromEnv);
  if (args.noPrompt) {
    return 'cancel';
  }
  const answer = await args.io.prompt(
    `Persona ${args.personaId} already exists. Choose update, destroy, or cancel`,
    { defaultValue: 'cancel' }
  );
  return expectOnExistsChoice(answer);
}

async function deleteAgent(args: {
  cloudUrl: string;
  workspaceId: string;
  agentId: string;
  token: string;
  action: string;
}): Promise<void> {
  const destroyUrl = `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    args.workspaceId
  )}/agents/${encodeURIComponent(args.agentId)}/destroy`;
  const res = await fetch(destroyUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.token}`,
      'user-agent': USER_AGENT
    }
  });
  if (res.status === 401) {
    throw new Error(`${args.action} failed: unauthorized. Run \`workforce login\` and retry.`);
  }
  if (res.status === 404 || res.status === 405) {
    throw new Error(
      `${args.action} failed: destroy not yet wired; cancel and run with --force-replace later.`
    );
  }
  if (!res.ok) {
    throw new Error(`${args.action} failed: ${res.status} ${await responseExcerpt(res)}`);
  }
}

/**
 * Pick the best-matching deployed-persona row out of a list response.
 *
 * Two shapes to handle:
 *
 *   * Legacy preview: `{ agent: {...} }` — a single object the server
 *     already filtered by persona via the URL path. We accept it without
 *     persona-side matching (back-compat); destroyed-status guard still
 *     applies.
 *   * New workspace deployments list (cloud#580): `{ agents: [...] }` —
 *     workspace-scoped, NOT persona-scoped. We must filter each row by
 *     `expectedPersonaId` ourselves, must not assume rows have persona
 *     fields populated, and must prefer the newest `active` row when
 *     multiple match (rare but possible during destroy/redeploy races).
 */
function parseExistingAgent(
  body: ExistingAgentResponse,
  expectedPersonaId?: string
): ExistingAgent | null {
  // Legacy single-object envelope: trust the server's path-level filter.
  const direct = parseAgentLike(body.agent, expectedPersonaId, {
    requirePersonaMatch: false
  });
  if (direct) return direct;

  if (!Array.isArray(body.agents)) return null;
  // The list endpoint is workspace-scoped, not persona-scoped, so every
  // matching row MUST identify the right persona. Skip rows that don't.
  const matches: Array<{ agent: ExistingAgent; createdAt: number }> = [];
  for (const value of body.agents) {
    const parsed = parseAgentLike(value, expectedPersonaId, {
      requirePersonaMatch: Boolean(expectedPersonaId)
    });
    if (!parsed) continue;
    const createdAtSrc = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).createdAt
      : undefined;
    const createdAtMs = typeof createdAtSrc === 'string' ? Date.parse(createdAtSrc) : NaN;
    matches.push({
      agent: parsed,
      createdAt: Number.isFinite(createdAtMs) ? createdAtMs : 0
    });
  }
  if (matches.length === 0) return null;
  // Prefer active rows; within each tier, prefer the most recently
  // created row so a destroy+redeploy race lands on the new agent
  // instead of the stale one.
  matches.sort((a, b) => {
    const aActive = a.agent.status === 'active' ? 1 : 0;
    const bActive = b.agent.status === 'active' ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.createdAt - a.createdAt;
  });
  return matches[0].agent;
}

/**
 * Coerce one row from a deploy-list response into the local
 * `ExistingAgent` shape. Cloud's `/deployments` GET (per cloud#580)
 * returns rows shaped `{ agentId, personaId (uuid), deployedName, status, ... }`;
 * older preview routes used `{ id, slug, status }`. We accept both
 * during the deploy-v1 rollout.
 *
 * When `expectedPersonaId` is supplied and `requirePersonaMatch` is
 * true, we match against the human-readable identifiers on the row —
 * `deployedName`, `slug`/`personaSlug`, or `personaId` (slug form on
 * the legacy endpoint). On the new workspace-scoped endpoint a row
 * without any persona-identifying field is NOT treated as a match —
 * the legacy "server pre-filtered the path so trust it" rationale
 * doesn't apply when the listing covers the whole workspace.
 */
function parseAgentLike(
  value: unknown,
  expectedPersonaId?: string,
  opts: { requirePersonaMatch?: boolean } = {}
): ExistingAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readFirstString(record, ['agentId', 'id']);
  if (!id) return null;
  if (expectedPersonaId) {
    const personaCandidates = [
      readFirstString(record, ['deployedName']),
      readFirstString(record, ['personaSlug', 'persona_slug', 'slug']),
      // `personaId` is a UUID on the new endpoint and a slug on the
      // legacy preview endpoint; trust an exact-string equality test
      // either way.
      readFirstString(record, ['personaId', 'persona_id'])
    ].filter((candidate): candidate is string => Boolean(candidate));
    if (personaCandidates.length === 0) {
      // Caller decides: legacy `{agent: ...}` path may trust the server
      // filter; workspace-scoped list must NOT.
      if (opts.requirePersonaMatch) return null;
    } else if (!personaCandidates.includes(expectedPersonaId)) {
      return null;
    }
  }
  // Treat destroyed rows as "not present" so a re-deploy with the same
  // persona slug doesn't trip the on-exists prompt against a tombstone.
  const status = typeof record.status === 'string' ? record.status : undefined;
  if (status === 'destroyed') return null;
  return {
    id,
    ...(status ? { status } : {})
  };
}

async function saveProviderCredential(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  modelProvider: string;
  authType: 'relay_managed' | 'byo_api_key';
  apiKey?: string;
}): Promise<string> {
  if (args.authType === 'relay_managed') {
    const url = new URL(`${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
      args.workspaceId
    )}/provider-credentials/managed`);
    url.searchParams.set('provider', args.modelProvider);
    const body = await requestJsonWithRetry<Record<string, unknown>>(
      url.toString(),
      {
        method: 'POST',
        headers: jsonHeaders(args.token)
      },
      { action: 'cloud managed provider credentials' }
    );
    return readCredentialId(body);
  }

  const body = await requestJsonWithRetry<Record<string, unknown>>(
    `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/provider-credentials/byok`,
    {
      method: 'POST',
      headers: jsonHeaders(args.token),
      body: JSON.stringify({
        // Keep both casings during the deploy-v1 rollout for the same mixed
        // preview/production route compatibility as the deploy payload above.
        modelProvider: args.modelProvider,
        model_provider: args.modelProvider,
        key: args.apiKey,
        api_key: args.apiKey
      })
    },
    { action: 'cloud BYOK provider credentials' }
  );
  return readCredentialId(body);
}

function deriveModelProvider(persona: PersonaSpec): string {
  // Callers gate on `persona.harness` being set before reaching here, so the
  // harness fallback is always a defined string in practice; default to
  // 'anthropic' to keep the return type total.
  const harnessFallback = persona.harness ?? 'anthropic';
  const model = typeof persona.model === 'string' ? persona.model.trim() : '';
  if (!model) return harnessFallback;
  const lower = model.toLowerCase();
  if (matchesProviderToken(lower, ['anthropic', 'claude'])) return 'anthropic';
  if (matchesProviderToken(lower, ['openai', 'codex', 'gpt'])) return 'openai';
  if (matchesProviderToken(lower, ['google', 'gemini'])) return 'google';
  if (matchesProviderToken(lower, ['openrouter', 'opencode'])) return 'openrouter';
  if (matchesProviderToken(lower, ['grok', 'xai', 'x-ai'])) return 'xai';
  const [provider] = model.split(/[/:]/, 1);
  if (provider?.trim()) return provider.trim().toLowerCase();
  return harnessFallback;
}

function matchesProviderToken(model: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => new RegExp(`^${escapeRegExp(token)}($|[/:._-])`).test(model));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCredentialId(body: Record<string, unknown>): string {
  const direct = readFirstString(body, ['providerCredentialId', 'provider_credential_id', 'credentialId', 'id']);
  if (direct) return direct;
  for (const field of ['credential', 'providerCredential']) {
    const nested = body[field];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedId = readFirstString(nested, ['id', 'providerCredentialId', 'provider_credential_id']);
      if (nestedId) return nestedId;
    }
  }
  throw new Error('cloud provider credentials response missing credential id');
}

/**
 * Walk the `/api/v1/cloud-agents` response and return the credential row id
 * of the first entry that represents a usable, connected credential for the
 * given model provider, or `null` when none matches.
 *
 * "Usable" means: the row exists, its `harness` field matches the persona's
 * derived model provider (case-insensitive), and its `status` is
 * `connected`. The S3-backed credential write happens before the row is
 * marked connected, so this single check is enough — no second probe
 * required.
 *
 * The response rows come straight from cloud's `provider_credentials`
 * table, where `harness` may hold either the model-provider string
 * ("anthropic") or the harness alias cloud's OAuth completion route stamps
 * ("claude"), depending on which write path created the row — so match
 * against both. Cloud lists rows most-recently-updated first.
 */
function connectedHarnessEntries(
  body: CloudAgentsListResponse,
  expectedProvider: string
): CloudAgentEntry[] {
  if (!body || !Array.isArray(body.agents)) return [];
  const provider = expectedProvider.trim().toLowerCase();
  if (!provider) return [];
  const targets = new Set([provider, harnessAliasForModelProvider(provider)]);
  const entries: CloudAgentEntry[] = [];
  for (const value of body.agents) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as CloudAgentEntry;
    if (typeof entry.harness !== 'string') continue;
    if (!targets.has(entry.harness.trim().toLowerCase())) continue;
    if (entry.status !== 'connected') continue;
    entries.push(entry);
  }
  return entries;
}

function hasConnectedHarness(body: CloudAgentsListResponse, expectedProvider: string): boolean {
  return connectedHarnessEntries(body, expectedProvider).length > 0;
}

function findConnectedHarnessCredentialId(
  body: CloudAgentsListResponse,
  expectedProvider: string
): string | null {
  const entries = connectedHarnessEntries(body, expectedProvider);
  // The web wizard selects on is_active (one active row per provider —
  // cloud's partial unique index), not recency, so prefer the flagged row.
  // Older clouds / pre-backfill rows may not carry the flag; fall back to
  // the list order (cloud returns most-recently-updated first).
  const candidates = [
    ...entries.filter(isActiveCloudAgentEntry),
    ...entries.filter((entry) => !isActiveCloudAgentEntry(entry))
  ];
  for (const entry of candidates) {
    if (typeof entry.id === 'string' && entry.id.trim()) return entry.id.trim();
  }
  return null;
}

function isActiveCloudAgentEntry(entry: CloudAgentEntry): boolean {
  return entry.isActive === true || entry.is_active === true;
}

/**
 * Mirror of cloud's `harnessForModelProvider` (lib/billing/house-keys.ts):
 * the harness name its OAuth completion route writes into
 * `provider_credentials.harness` for each model provider.
 */
function harnessAliasForModelProvider(modelProvider: string): string {
  switch (modelProvider) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    case 'google':
      return 'gemini';
    case 'openrouter':
      return 'opencode';
    case 'xai':
      return 'grok';
    default:
      return modelProvider;
  }
}

function expectHarnessSource(value: string): HarnessSource {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan' || normalized === 'byok' || normalized === 'oauth') {
    return normalized;
  }
  throw new Error(`cloud: harness source must be one of plan|byok|oauth; got "${value}"`);
}

function expectOnExistsChoice(value: string): OnExistsChoice {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'update' || normalized === 'destroy' || normalized === 'cancel') {
    return normalized;
  }
  throw new Error(`cloud: on-exists must be one of update|destroy|cancel; got "${value}"`);
}

function readFirstString(
  body: object,
  fields: readonly string[]
): string | undefined {
  const record = body as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMessage: string
): Promise<void> {
  const deadline = Date.now() + pollTimeoutMs();
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(pollIntervalMs());
  }
  throw new Error(timeoutMessage);
}

function readPersonaCloudDeployUrl(persona: PersonaSpec): string | undefined {
  const cloud = (persona as PersonaSpec & { cloud?: unknown }).cloud;
  if (cloud !== null && typeof cloud === 'object' && 'deployUrl' in cloud) {
    const deployUrl = (cloud as { deployUrl?: unknown }).deployUrl;
    if (typeof deployUrl === 'string' && deployUrl.trim()) {
      return deployUrl.trim();
    }
  }
  return undefined;
}

function normalizeCloudUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return normalizeCloudUrl(defaultApiUrl());
  return trimmed.replace(/\/+$/, '');
}

async function readUsableCloudAuth(apiUrl: string): Promise<StoredAuth | null> {
  let auth = await cloudCredentialDeps.readStoredAuth().catch(() => null);
  if (!auth) return null;
  if (isAuthExpired(auth.accessTokenExpiresAt)) {
    auth = await cloudCredentialDeps.refreshStoredAuth(auth).catch((err) => {
      console.warn(`cloud: stored auth refresh failed: ${formatErrorMessage(err)}`);
      return null;
    });
  }
  if (!auth) return null;
  return {
    ...auth,
    apiUrl
  };
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAuthExpired(expiresAt: string): boolean {
  const millis = Date.parse(expiresAt);
  return Number.isNaN(millis) || millis <= Date.now() + 60_000;
}

function readInputsOverride(): Record<string, string> | undefined {
  const raw = process.env.WORKFORCE_DEPLOY_INPUTS_JSON?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WORKFORCE_DEPLOY_INPUTS_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WORKFORCE_DEPLOY_INPUTS_JSON must be a JSON object');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`WORKFORCE_DEPLOY_INPUTS_JSON.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

async function pollAgentStatus(args: {
  cloudUrl: string;
  workspaceId: string;
  agentId: string;
  token: WorkspaceAuthToken['token'];
  io: ModeLaunchInput['io'];
  onLog?: ModeLaunchInput['onLog'];
}): Promise<'ready' | 'active' | 'failed'> {
  const statusUrl = `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    args.workspaceId
  )}/agents/${encodeURIComponent(args.agentId)}`;
  const deadline = Date.now() + pollTimeoutMs();
  let lastStatus = 'starting';

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs());
    const body = await requestJsonWithRetry<CloudAgentStatusResponse>(
      statusUrl,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${args.token}`,
          'user-agent': USER_AGENT
        }
      },
      { action: 'cloud status poll' }
    );
    const status = expectStatus(body.status);
    if (status !== lastStatus) {
      emitLog(args, `cloud: status ${status}`);
      lastStatus = status;
    }
    if (status === 'ready' || status === 'active' || status === 'failed') return status;
  }

  throw new Error(`timed out after ${pollTimeoutMs() / 1000}s waiting for agent ${args.agentId}`);
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': USER_AGENT
  };
}

async function requestJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  opts: { action: string }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status === 401) {
        throw new Error(`${opts.action} failed: unauthorized. Run \`workforce login\` and retry.`);
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`${opts.action} failed: ${res.status} ${await responseExcerpt(res)}`);
      } else if (!res.ok) {
        throw new Error(`${opts.action} failed: ${res.status} ${await responseExcerpt(res)}`);
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS || !isRetryableError(err)) {
        throw err;
      }
    }
    await sleep(backoffMs(attempt));
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes('unauthorized')) return false;
  if (err.message.includes('failed: 4')) return false;
  return true;
}

function backoffMs(attempt: number): number {
  const override = numberFromEnv('WORKFORCE_DEPLOY_RETRY_BACKOFF_MS');
  return override ?? attempt * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitLog(args: {
  io: ModeLaunchInput['io'];
  onLog?: ModeLaunchInput['onLog'];
}, line: string): void {
  args.onLog?.(line);
  args.io.info(line);
}

function pollTimeoutMs(): number {
  return numberFromEnv('WORKFORCE_DEPLOY_POLL_TIMEOUT_MS') ?? POLL_TIMEOUT_MS;
}

function pollIntervalMs(): number {
  return numberFromEnv('WORKFORCE_DEPLOY_POLL_INTERVAL_MS') ?? POLL_INTERVAL_MS;
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function responseExcerpt(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.trim().slice(0, 500);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`cloud deploy response missing ${field}`);
  }
  return value;
}

function expectStatus(value: unknown): CloudDeployStatus {
  if (
    value === 'ready'
    || value === 'starting'
    || value === 'active'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value;
  }
  throw new Error(`cloud deploy response has unknown status "${String(value)}"`);
}
