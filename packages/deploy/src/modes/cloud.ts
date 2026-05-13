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
} from '../types.js';
import {
  resolveWorkspaceToken,
  type WorkspaceAuthToken
} from '../login.js';

const BUILD_YOUR_OWN_CLOUD_DOCS_URL = 'https://docs.agentworkforce.com/deploy/build-your-own-cloud';
const USER_AGENT = 'workforce-deploy';
const MAX_ATTEMPTS = 3;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

type CloudDeployStatus = 'starting' | 'active' | 'failed' | 'cancelled';
type HarnessSource = 'plan' | 'byok' | 'oauth';
type OnExistsChoice = 'update' | 'destroy' | 'cancel';

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

interface ProviderCredentialsResponse {
  credentials?: unknown;
  providerCredentials?: unknown;
  credential?: unknown;
  id?: unknown;
  authType?: unknown;
  auth_type?: unknown;
  status?: unknown;
  connected?: unknown;
  credentialStoredAt?: unknown;
  createdAt?: unknown;
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

    const credentialSelections = await ensureHarnessReady({
      cloudUrl,
      workspaceId: input.workspace,
      token: auth.token,
      persona: input.persona,
      io: input.io,
      noPrompt,
      harnessSource: input.harnessSource,
      byokKey: input.byokKey
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

    const endpoint = `${cloudUrl}/api/v1/workspaces/${encodeURIComponent(
      input.workspace
    )}/deployments`;

    const body = JSON.stringify({
      persona: input.persona,
      bundle: {
        runner: await readFile(input.bundle.runnerPath, 'utf8'),
        agent: await readFile(input.bundle.bundlePath, 'utf8'),
        packageJson: JSON.parse(await readFile(input.bundle.packageJsonPath, 'utf8')) as unknown
      },
      credentialSelections,
      credential_selections: credentialSelections,
      inputs: input.inputs ?? readInputsOverride()
    });

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
      if (initialStatus === 'active') return { code: 0 };
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
        return { code: finalStatus === 'active' ? 0 : 1 };
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
}): Promise<Record<string, string>> {
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
  return {};
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

async function isHarnessOauthConnected(args: {
  cloudUrl: string;
  persona: PersonaSpec;
}): Promise<boolean> {
  const auth = await readUsableCloudAuth(args.cloudUrl);
  if (!auth) return false;
  const client = cloudCredentialDeps.createCloudApiClient(auth, args.cloudUrl);
  const path = `/api/v1/users/me/provider_credentials?model_provider=${encodeURIComponent(
    deriveModelProvider(args.persona)
  )}`;
  const res = await client.fetch(path, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT }
  });
  if (res.status === 404 || res.status === 405) return false;
  if (res.status === 401) {
    throw new Error('cloud harness check failed: unauthorized. Run `workforce login` and retry.');
  }
  if (!res.ok) {
    throw new Error(`cloud harness check failed: ${res.status} ${await responseExcerpt(res)}`);
  }
  const body = (await res.json()) as ProviderCredentialsResponse;
  return providerCredentialsReady(body);
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
}): Promise<void> {
  if (await isHarnessOauthConnected(args)) {
    args.io.info(`cloud: ${args.persona.harness} credentials already connected`);
    return;
  }
  if (args.noPrompt) {
    throw new Error(
      `cloud: ${args.persona.harness} OAuth credentials are not connected. Run without --no-prompt or choose --harness-source plan/byok.`
    );
  }
  const ok = await args.io.confirm(
    `Connect ${args.persona.harness} credentials now? (opens browser)`,
    { defaultValue: true }
  );
  if (!ok) {
    throw new Error(`cloud: ${args.persona.harness} credentials are required for deploy`);
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

async function findExistingAgent(args: {
  cloudUrl: string;
  workspaceId: string;
  token: string;
  personaId: string;
}): Promise<ExistingAgent | null> {
  const url = `${args.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    args.workspaceId
  )}/agents?persona_slug=${encodeURIComponent(args.personaId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${args.token}`,
      'user-agent': USER_AGENT
    }
  });
  if (res.status === 404 || res.status === 405) return null;
  if (res.status === 401) {
    throw new Error('cloud existing persona check failed: unauthorized. Run `workforce login` and retry.');
  }
  if (!res.ok) {
    throw new Error(`cloud existing persona check failed: ${res.status} ${await responseExcerpt(res)}`);
  }
  return parseExistingAgent((await res.json()) as ExistingAgentResponse);
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

function parseExistingAgent(body: ExistingAgentResponse): ExistingAgent | null {
  const direct = parseAgentLike(body.agent);
  if (direct) return direct;
  if (Array.isArray(body.agents)) {
    for (const agent of body.agents) {
      const parsed = parseAgentLike(agent);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseAgentLike(value: unknown): ExistingAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  return {
    id: record.id,
    ...(typeof record.status === 'string' ? { status: record.status } : {})
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
  const model = typeof persona.model === 'string' ? persona.model.trim() : '';
  const lower = model.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic';
  if (lower.includes('openai') || lower.includes('codex') || lower.includes('gpt')) return 'openai';
  if (lower.includes('google') || lower.includes('gemini')) return 'google';
  if (lower.includes('openrouter') || lower.includes('opencode')) return 'openrouter';
  const [provider] = model.split(/[/:]/, 1);
  if (provider?.trim()) return provider.trim().toLowerCase();
  return persona.harness;
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

function providerCredentialsReady(body: ProviderCredentialsResponse): boolean {
  const candidates = [
    body.credential,
    ...(Array.isArray(body.credentials) ? body.credentials : []),
    ...(Array.isArray(body.providerCredentials) ? body.providerCredentials : []),
    body
  ];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    return record.connected === true
      || record.status === 'connected'
      || record.status === 'active'
      || Boolean(record.credentialStoredAt)
      || Boolean(record.createdAt)
      || typeof record.id === 'string';
  });
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
    auth = await cloudCredentialDeps.refreshStoredAuth(auth).catch(() => null);
  }
  if (!auth) return null;
  return {
    ...auth,
    apiUrl
  };
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
}): Promise<'active' | 'failed'> {
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
    if (status === 'active' || status === 'failed') return status;
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
  if (value === 'starting' || value === 'active' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw new Error(`cloud deploy response has unknown status "${String(value)}"`);
}
