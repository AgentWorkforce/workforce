import {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG,
  KNOWN_TRIGGER_PROVIDER_ALIASES
} from '@agentworkforce/persona-kit';
import { resolveCloudUrl } from './cloud-url.js';
import { createBufferedIO } from './io.js';
import { readActiveWorkspace, resolveWorkspaceToken, type ActiveWorkspacePointer } from './login.js';

export type AuthState = 'authenticated' | 'unauthenticated';
export type TriggerSource = 'catalog' | 'none';
export type IntegrationScope = 'deployer_user' | 'workspace' | 'workspace_service_account';

export interface IntegrationConnection {
  connectionId: string;
  scope: IntegrationScope;
  serviceAccountName: string | null;
  status: string;
}

export interface IntegrationRow {
  id: string;
  adapterSlug: string;
  inCloudCatalog: boolean;
  connected: boolean | null;
  connections: IntegrationConnection[] | null;
  triggers: string[];
  triggerSource: TriggerSource;
}

export interface IntegrationsDocument {
  workspaceId: string | null;
  auth: AuthState;
  integrations: IntegrationRow[];
  warnings: string[];
}

export interface CloudApiClientLike {
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface ListIntegrationsOptions {
  client?: CloudApiClientLike;
  workspaceId?: string;
  token?: string;
  cloudUrl?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  activeWorkspace?: ActiveWorkspacePointer | null;
  readActiveWorkspace?: typeof readActiveWorkspace;
  resolveWorkspaceToken?: typeof resolveWorkspaceToken;
  provider?: string;
  includeTriggers?: boolean;
}

export class IntegrationsListError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: string;

  constructor(message: string, args: { status: number; endpoint: string; body: string }) {
    super(message);
    this.name = 'IntegrationsListError';
    this.status = args.status;
    this.endpoint = args.endpoint;
    this.body = args.body;
  }
}

export class UnknownIntegrationProviderError extends Error {
  readonly provider: string;
  readonly suggestion: string | undefined;
  readonly validProviders: string[];

  constructor(provider: string, validProviders: string[], suggestion?: string) {
    super(
      `unknown integration provider "${provider}".` +
        (suggestion ? ` Did you mean "${suggestion}"?` : '') +
        (validProviders.length ? ` Valid providers: ${validProviders.join(', ')}.` : '')
    );
    this.name = 'UnknownIntegrationProviderError';
    this.provider = provider;
    this.validProviders = validProviders;
    this.suggestion = suggestion;
  }
}

export async function listIntegrations(
  options: ListIntegrationsOptions = {}
): Promise<IntegrationsDocument> {
  const env = options.env ?? process.env;
  const active = options.activeWorkspace !== undefined
    ? options.activeWorkspace
    : await (options.readActiveWorkspace ?? readActiveWorkspace)().catch(() => null);
  const cloudUrl = resolveCloudUrl({ env, active, ...(options.cloudUrl ? { flag: options.cloudUrl } : {}) });
  const auth = await resolveAuth(options, cloudUrl, active, env);

  let catalogEntries: CloudCatalogEntry[] = [];
  const warnings: string[] = [];
  try {
    catalogEntries = await fetchCloudCatalog(options, auth, cloudUrl);
  } catch (err) {
    if (auth.auth === 'authenticated') throw err;
    warnings.push(
      `cloud integration catalog unavailable; showing trigger catalog only (partial, cloud-only/connect-only integrations omitted): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const rows = buildRows(catalogEntries, auth, options.includeTriggers !== false);
  const cloudProviderIds = new Set(catalogEntries.map((entry) => entry.id));
  for (const row of rows) {
    if (!row.inCloudCatalog && !cloudProviderIds.has(row.id)) {
      warnings.push(`${row.id}: in trigger catalog but not in cloud catalog`);
    }
  }

  if (auth.auth === 'authenticated') {
    await hydrateConnections(rows, options, {
      ...auth,
      auth: 'authenticated'
    }, cloudUrl);
  }

  const filtered = filterProvider(rows, options.provider);
  return {
    workspaceId: auth.workspaceId,
    auth: auth.auth,
    integrations: filtered,
    warnings
  };
}

export function resolveIntegrationProvider(
  provider: string,
  rows: readonly Pick<IntegrationRow, 'id' | 'adapterSlug'>[]
): string {
  const exact = rows.find((row) => row.id === provider);
  if (exact) return exact.id;
  const alias = rows.find((row) => row.adapterSlug === provider);
  if (alias) return alias.id;
  throw new UnknownIntegrationProviderError(
    provider,
    rows.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
    suggestProvider(provider, rows)
  );
}

interface ResolvedAuth {
  auth: AuthState;
  workspaceId: string | null;
  token?: string;
}

interface CloudCatalogEntry {
  id: string;
}

async function resolveAuth(
  options: ListIntegrationsOptions,
  cloudUrl: string,
  active: ActiveWorkspacePointer | null,
  env: NodeJS.ProcessEnv
): Promise<ResolvedAuth> {
  const workspaceId = firstString(
    options.workspaceId,
    env.WORKFORCE_WORKSPACE_ID,
    active?.workspaceId,
    active?.workspaceSlug,
    active?.workspace
  );
  if (options.token) {
    return { auth: 'authenticated', workspaceId: workspaceId ?? null, token: options.token };
  }

  try {
    const resolved = await (options.resolveWorkspaceToken ?? resolveWorkspaceToken)({
      ...(workspaceId ? { workspace: workspaceId } : {}),
      cloudUrl,
      io: createBufferedIO(),
      noPrompt: true
    });
    return {
      auth: 'authenticated',
      workspaceId: firstString(resolved.workspace, workspaceId) ?? null,
      token: resolved.token
    };
  } catch {
    return { auth: 'unauthenticated', workspaceId: workspaceId ?? null };
  }
}

async function fetchCloudCatalog(
  options: ListIntegrationsOptions,
  auth: ResolvedAuth,
  cloudUrl: string
): Promise<CloudCatalogEntry[]> {
  const body = await requestJson(options, auth, cloudUrl, '/api/v1/integrations/catalog');
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { providers?: unknown }).providers)
      ? (body as { providers: unknown[] }).providers
      : [];
  const entries: CloudCatalogEntry[] = [];
  for (const item of raw) {
    const id = readString(item, 'id') ?? readString(item, 'provider');
    if (id) entries.push({ id });
  }
  return entries;
}

function buildRows(
  cloudEntries: readonly CloudCatalogEntry[],
  auth: ResolvedAuth,
  includeTriggers: boolean
): IntegrationRow[] {
  const rows = new Map<string, IntegrationRow>();
  for (const entry of cloudEntries) {
    const adapterSlug = adapterSlugForCloudProvider(entry.id);
    const triggers = includeTriggers ? triggersForAdapter(adapterSlug) : [];
    rows.set(entry.id, {
      id: entry.id,
      adapterSlug,
      inCloudCatalog: true,
      connected: auth.auth === 'authenticated' ? false : null,
      connections: auth.auth === 'authenticated' ? [] : null,
      triggers,
      triggerSource: includeTriggers && triggers.length > 0 ? 'catalog' : 'none'
    });
  }

  if (includeTriggers) {
    const triggerCatalog = KNOWN_TRIGGER_CATALOG as Record<string, readonly string[]>;
    for (const [adapterSlug, triggers] of Object.entries(triggerCatalog)) {
      const id = cloudProviderForAdapter(adapterSlug);
      if (rows.has(id)) continue;
      rows.set(id, {
        id,
        adapterSlug,
        inCloudCatalog: false,
        connected: auth.auth === 'authenticated' ? false : null,
        connections: auth.auth === 'authenticated' ? [] : null,
        triggers: [...triggers],
        triggerSource: triggers.length > 0 ? 'catalog' : 'none'
      });
    }
  }

  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function hydrateConnections(
  rows: IntegrationRow[],
  options: ListIntegrationsOptions,
  auth: ResolvedAuth & { auth: 'authenticated'; token?: string },
  cloudUrl: string
): Promise<void> {
  if (!auth.workspaceId) {
    throw new Error('workspace is required: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `agentworkforce login`');
  }
  const byProvider = new Map(rows.map((row) => [row.id, row]));
  const userList = await requestJson(options, auth, cloudUrl, '/api/v1/me/integrations');
  addConnectionsFromList(byProvider, userList, 'deployer_user');
  const workspacePath = `/api/v1/workspaces/${encodeURIComponent(auth.workspaceId)}/integrations`;
  const workspaceList = await requestJson(options, auth, cloudUrl, workspacePath);
  addConnectionsFromList(byProvider, workspaceList, 'workspace');

  for (const row of rows) {
    if (!row.inCloudCatalog) continue;
    await addStatusConnection(row, options, auth, cloudUrl, 'deployer_user');
    await addStatusConnection(row, options, auth, cloudUrl, 'workspace');
  }

  for (const row of rows) {
    const connections = row.connections ?? [];
    row.connections = dedupeConnections(connections);
    row.connected = row.connections.some((connection) => isConnectedStatus(connection.status));
  }
}

async function addStatusConnection(
  row: IntegrationRow,
  options: ListIntegrationsOptions,
  auth: ResolvedAuth & { auth: 'authenticated'; token?: string },
  cloudUrl: string,
  scope: IntegrationScope
): Promise<void> {
  if (!auth.workspaceId) return;
  const path =
    `/api/v1/workspaces/${encodeURIComponent(auth.workspaceId)}` +
    `/integrations/${encodeURIComponent(row.id)}/status?scope=${encodeURIComponent(scope)}`;
  const body = await requestJson(options, auth, cloudUrl, path);
  const connections = row.connections ?? [];
  addConnectionsFromStatus(connections, body, row.id, scope);
  row.connections = connections;
}

function addConnectionsFromList(
  rows: Map<string, IntegrationRow>,
  body: unknown,
  fallbackScope: IntegrationScope
): void {
  for (const item of readItems(body)) {
    const provider = readString(item, 'provider') ?? readString(item, 'id');
    if (!provider) continue;
    const row = rows.get(provider);
    if (!row) continue;
    const connections = row.connections ?? [];
    connections.push(connectionFromRecord(item, fallbackScope, provider));
    row.connections = connections;
  }
}

function addConnectionsFromStatus(
  connections: IntegrationConnection[],
  body: unknown,
  provider: string,
  fallbackScope: IntegrationScope
): void {
  const items = readItems(body);
  if (items.length > 0) {
    for (const item of items) connections.push(connectionFromRecord(item, fallbackScope, provider));
    return;
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    connections.push(connectionFromRecord(body, fallbackScope, provider));
  }
}

function connectionFromRecord(
  value: unknown,
  fallbackScope: IntegrationScope,
  provider: string
): IntegrationConnection {
  const scope = readScope(value) ?? fallbackScope;
  return {
    connectionId:
      readString(value, 'connectionId') ??
      readString(value, 'currentConnectionId') ??
      readString(value, 'id') ??
      provider,
    scope,
    serviceAccountName:
      readString(value, 'serviceAccountName') ??
      readString(value, 'name') ??
      null,
    status: readStatus(value)
  };
}

function dedupeConnections(connections: readonly IntegrationConnection[]): IntegrationConnection[] {
  const seen = new Set<string>();
  const out: IntegrationConnection[] = [];
  for (const connection of connections) {
    const key = [
      connection.connectionId,
      connection.scope,
      connection.serviceAccountName ?? '',
      connection.status
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(connection);
  }
  return out;
}

function filterProvider(rows: IntegrationRow[], provider: string | undefined): IntegrationRow[] {
  if (!provider) return rows;
  const id = resolveIntegrationProvider(provider, rows);
  return rows.filter((row) => row.id === id);
}

async function requestJson(
  options: ListIntegrationsOptions,
  auth: ResolvedAuth,
  cloudUrl: string,
  pathname: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = options.client
    ? await options.client.fetch(pathname, init)
    : await (options.fetch ?? fetch)(`${cloudUrl}${pathname}`, {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
          ...(init.headers ?? {})
        }
      });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const excerpt = body.length > 400 ? `${body.slice(0, 400)}...` : body;
    throw new IntegrationsListError(
      `integration catalog/status request failed: ${response.status} ${pathname}${excerpt ? ` ${excerpt}` : ''}`,
      { status: response.status, endpoint: pathname, body: excerpt }
    );
  }
  return await response.json();
}

function adapterSlugForCloudProvider(provider: string): string {
  return (KNOWN_TRIGGER_PROVIDER_ALIASES as Record<string, string | undefined>)[provider] ?? provider;
}

function cloudProviderForAdapter(adapterSlug: string): string {
  for (const [cloudProvider, adapter] of Object.entries(KNOWN_TRIGGER_PROVIDER_ALIASES)) {
    if (adapter === adapterSlug) return cloudProvider;
  }
  return adapterSlug;
}

function triggersForAdapter(adapterSlug: string): string[] {
  const known = (KNOWN_TRIGGER_CATALOG as Record<string, readonly string[] | undefined>)[adapterSlug];
  if (known) return [...known];
  const noKnown = new Set(
    (ADAPTERS_WITHOUT_KNOWN_TRIGGERS as readonly { provider: string }[]).map((entry) => entry.provider)
  );
  if (noKnown.has(adapterSlug)) return [];
  return [];
}

function readItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const field of ['integrations', 'connections', 'items', 'data']) {
    if (Array.isArray(record[field])) return record[field];
  }
  return [];
}

function readScope(value: unknown): IntegrationScope | undefined {
  const raw = readString(value, 'scope') ?? readString(value, 'source');
  if (raw === 'deployer_user' || raw === 'workspace' || raw === 'workspace_service_account') {
    return raw;
  }
  if (raw === 'user') return 'deployer_user';
  return undefined;
}

function readStatus(value: unknown): string {
  const status = readString(value, 'status') ?? readString(value, 'state');
  if (status) return status;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const oauth = record.oauth;
    if (oauth && typeof oauth === 'object' && !Array.isArray(oauth)) {
      if ((oauth as Record<string, unknown>).connected === true) return 'connected';
    }
    if (record.ready === true) return 'ready';
    if (record.connected === true) return 'connected';
  }
  return 'unknown';
}

function isConnectedStatus(status: string): boolean {
  return status === 'ready' || status === 'connected';
}

function readString(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function firstString(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function suggestProvider(
  requested: string,
  rows: readonly Pick<IntegrationRow, 'id' | 'adapterSlug'>[]
): string | undefined {
  const lower = requested.toLowerCase();
  for (const row of rows) {
    if (row.adapterSlug.toLowerCase() === lower) return row.id;
  }
  let best: { id: string; score: number } | undefined;
  for (const row of rows) {
    const idCandidate = row.id.toLowerCase();
    const adapterCandidate = row.adapterSlug.toLowerCase();
    const score = Math.max(
      longestCommonSubstring(lower, idCandidate),
      longestCommonSubstring(lower, adapterCandidate),
      levenshteinScore(lower, idCandidate),
      levenshteinScore(lower, adapterCandidate)
    );
    if (!best || score > best.score) best = { id: row.id, score };
  }
  return best && best.score >= 3 ? best.id : undefined;
}

function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      best = Math.max(best, dp[j]);
      prev = tmp;
    }
  }
  return best;
}

function levenshteinScore(a: string, b: string): number {
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
  const distance = row[b.length];
  return distance <= 2 ? 4 - distance : 0;
}
