import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  readStoredAuth,
  refreshStoredAuth,
  writeStoredAuth,
  type StoredAuth
} from '@agent-relay/cloud';
import { canonicalizeCloudUrl } from './cloud-url.js';
import type { DeployIO } from './types.js';

/**
 * Workspace authentication primitives. The CLI layer plugs in real
 * implementations that talk to relayauth + the workforce cloud API; this
 * module only resolves the workspace-scoped token needed by deploy modes.
 */
export interface WorkspaceAuth {
  /** Resolve the active workspace, prompting the user to pick one if needed. */
  resolveWorkspace(args: { override?: string; io: DeployIO }): Promise<{
    workspace: string;
    /** Workspace-scoped token usable for gateway + cloud API calls. */
    token: string;
  }>;
}

export interface WorkspaceAuthToken {
  token: string;
}

export interface StoredWorkspaceLogin {
  workspace?: string;
  workspaceSlug?: string;
  workspaceId?: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  cloudUrl?: string;
}

type WorkforceStoredAuth = StoredAuth & {
  workforce?: {
    activeWorkspace?: string;
    workspaceTokens?: Record<string, StoredWorkspaceLogin>;
  };
  workspace?: string;
  workspaceSlug?: string;
  workspaceId?: string;
  workspaceToken?: string;
  workforceWorkspaceToken?: StoredWorkspaceLogin;
};

function loginFile(): string {
  return process.env.WORKFORCE_LOGIN_FILE?.trim()
    || path.join(homedir(), '.agentworkforce', 'login.json');
}

/**
 * Tiny pointer file recording the workspace + cloud URL the user picked at
 * `agentworkforce login`. The access token itself lives in the shared
 * `@agent-relay/cloud` auth store (`~/.agent-relay/cloud-auth.json`); this
 * file just remembers which workspace to target so `resolveWorkspaceToken`
 * can pair "user identity" (shared accessToken) with "which workspace to
 * deploy to" without re-prompting on every invocation.
 *
 * This file is non-secret. The actual bearer credential lives in the
 * shared auth file, which `@agent-relay/cloud` manages.
 */
export interface ActiveWorkspacePointer {
  /** Whatever the user passed at login time (slug, id, or display name). */
  workspace: string;
  /** Canonical slug, if known. */
  workspaceSlug?: string;
  /** Canonical workspace id (uuid), if known. */
  workspaceId?: string;
  /** Cloud base URL we authed against. */
  cloudUrl?: string;
  /** ISO timestamp of the most recent write. */
  setAt: string;
}

function activeWorkspaceFile(): string {
  return process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE?.trim()
    || path.join(homedir(), '.agentworkforce', 'active.json');
}

export async function readActiveWorkspace(): Promise<ActiveWorkspacePointer | null> {
  const raw = await readFile(activeWorkspaceFile(), 'utf8').catch(() => '');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : '';
    if (!workspace) return null;
    return {
      workspace,
      setAt: typeof record.setAt === 'string' ? record.setAt : new Date(0).toISOString(),
      ...(typeof record.workspaceSlug === 'string' && record.workspaceSlug.trim()
        ? { workspaceSlug: record.workspaceSlug.trim() }
        : {}),
      ...(typeof record.workspaceId === 'string' && record.workspaceId.trim()
        ? { workspaceId: record.workspaceId.trim() }
        : {}),
      ...(typeof record.cloudUrl === 'string' && record.cloudUrl.trim()
        ? { cloudUrl: record.cloudUrl.trim() }
        : {})
    };
  } catch {
    return null;
  }
}

export async function writeActiveWorkspace(
  input: Omit<ActiveWorkspacePointer, 'setAt'>
): Promise<void> {
  const file = activeWorkspaceFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Canonicalize at write time so we never persist an edge / origin-bypass
  // hostname (e.g. origin.agentrelay.cloud) into active.json. Downstream
  // readers can trust the stored value and skip canonicalization.
  const cloudUrl = input.cloudUrl ? canonicalizeCloudUrl(input.cloudUrl) : undefined;
  const payload: ActiveWorkspacePointer = {
    workspace: input.workspace,
    ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    setAt: new Date().toISOString()
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

export async function clearActiveWorkspace(): Promise<void> {
  await rm(activeWorkspaceFile(), { force: true });
}

/**
 * Environment-backed fallback resolver: reads `WORKFORCE_WORKSPACE_ID`
 * and `WORKFORCE_WORKSPACE_TOKEN` from `process.env`. Useful in CI and as
 * a sane default before the CLI wires up the OAuth flow.
 */
export function envWorkspaceAuth(): WorkspaceAuth {
  return {
    async resolveWorkspace({ override, io }) {
      // Normalize whitespace-only values to "missing" — a token of `"  "`
      // is no more usable than an empty string, and silently passing one
      // through produces a confusing 401 later instead of a clear setup
      // error here.
      const workspace = (override ?? process.env.WORKFORCE_WORKSPACE_ID ?? '').trim();
      const token = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
      if (workspace && token) {
        return { workspace, token };
      }

      const stored = await loadWorkspaceToken(workspace || undefined);
      if (stored) {
        const storedWorkspace = storedWorkspaceName(stored);
        if (storedWorkspace) return { workspace: storedWorkspace, token: stored.token };
      }

      if (!workspace) {
        io.error(
          'no workspace resolved: pass --workspace, set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN, or run `agentworkforce login`'
        );
        throw new Error('workspace is required for deploy');
      }

      io.error(
        `no workspace token resolved for ${workspace}: set WORKFORCE_WORKSPACE_TOKEN, or run \`agentworkforce login\``
      );
      throw new Error('workspace token is required for deploy');
    }
  };
}

/**
 * Resolve the workspace token for mode launchers that need to call cloud
 * APIs directly. The deploy orchestrator resolves workspace identity before
 * launch; this helper keeps the token lookup in the auth module until the
 * browser/keychain login flow replaces the env fallback.
 */
export function resolveWorkspaceTokenFromEnv(workspace: string): WorkspaceAuthToken {
  const token = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      `no workspace token resolved for ${workspace}: run \`workforce login\` or set WORKFORCE_WORKSPACE_TOKEN`
    );
  }
  return { token };
}

export async function resolveWorkspaceToken(args: {
  workspace?: string;
  cloudUrl: string;
  io: DeployIO;
  noPrompt?: boolean;
}): Promise<WorkspaceAuthToken & { workspace?: string }> {
  // Defensively canonicalize the incoming cloud URL so any per-call
  // matching (e.g. cloudUrlMatches in loadWorkspaceToken) compares against
  // the public canonical host rather than an origin-bypass hostname.
  const cloudUrl = canonicalizeCloudUrl(args.cloudUrl);
  const envWorkspace = (process.env.WORKFORCE_WORKSPACE_ID ?? '').trim();
  const fromEnv = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
  const requestedWorkspace = (args.workspace ?? '').trim();

  // Tier 1: explicit env vars (CI / headless). Preserved untouched so
  // pipelines that already set WORKFORCE_WORKSPACE_TOKEN keep working.
  if (fromEnv && (requestedWorkspace || envWorkspace)) {
    return {
      token: fromEnv,
      workspace: requestedWorkspace || envWorkspace
    };
  }

  // Tier 2: shared @agent-relay/cloud accessToken + active.json pointer.
  // This is the interactive-CLI default after `agentworkforce login`: the
  // user already has a valid accessToken in ~/.agent-relay/cloud-auth.json
  // and cloud's resolveRequestAuth accepts that token as Bearer for the
  // deployment endpoints — no workspace-scoped token mint required.
  const sharedAuth = await readSharedAuthForBearer().catch(() => null);
  if (sharedAuth?.accessToken) {
    const active = await readActiveWorkspace().catch(() => null);
    const workspace = requestedWorkspace
      || envWorkspace
      || active?.workspaceSlug
      || active?.workspaceId
      || active?.workspace;
    if (workspace) {
      return { token: sharedAuth.accessToken, workspace };
    }
  }

  // Tier 3: legacy keychain / file-stored workspace token. Kept for users
  // mid-upgrade who already have a minted workspace token from the old
  // login flow.
  const stored = await loadWorkspaceToken(requestedWorkspace || undefined, cloudUrl);
  if (stored) {
    return {
      token: stored.token,
      ...(storedWorkspaceName(stored) ? { workspace: storedWorkspaceName(stored) } : {})
    };
  }

  if (args.noPrompt) {
    throw new Error(
      `no workspace credentials resolved${requestedWorkspace ? ` for ${requestedWorkspace}` : ''}: run \`agentworkforce login\` or set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN`
    );
  }

  args.io.info('cloud: no workspace credentials found; run `agentworkforce login` to connect this machine');
  throw new Error(
    `no workspace credentials resolved${requestedWorkspace ? ` for ${requestedWorkspace}` : ''}: run \`agentworkforce login\` or set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN`
  );
}

/**
 * Read the shared @agent-relay/cloud auth, refreshing if the accessToken
 * is expired and a refreshToken is available. Returns `null` on any
 * failure — callers fall through to the next resolution tier.
 *
 * Set `WORKFORCE_DISABLE_SHARED_AUTH=1` (or any truthy value) to skip
 * the shared-auth read entirely. Primary use cases:
 *   - Hermetic tests that must not pick up the host machine's
 *     `~/.agent-relay/cloud-auth.json`.
 *   - Users who want the CLI to behave as if they had never run
 *     `agent-relay cloud login` (e.g. to force env-only operation in CI).
 */
async function readSharedAuthForBearer(): Promise<StoredAuth | null> {
  if (isTruthyEnv(process.env.WORKFORCE_DISABLE_SHARED_AUTH)) return null;
  const auth = await readStoredAuth().catch(() => null);
  if (!auth || !auth.accessToken) return null;
  if (!isExpired(auth.accessTokenExpiresAt)) return auth;
  if (!auth.refreshToken) return null;
  try {
    return await refreshStoredAuth(auth);
  } catch {
    return null;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export async function loadWorkspaceToken(
  workspace?: string,
  cloudUrl?: string
): Promise<StoredWorkspaceLogin | null> {
  const fromCloudAuth = await readWorkspaceTokenFromCloudAuth(workspace, cloudUrl);
  if (fromCloudAuth && !isExpired(fromCloudAuth.expiresAt)) {
    return fromCloudAuth;
  }

  const fromFile = await readLoginFile();
  if (
    fromFile
    && workspaceMatches(fromFile, workspace)
    && cloudUrlMatches(fromFile, cloudUrl)
    && !isExpired(fromFile.expiresAt)
  ) {
    return fromFile;
  }

  return null;
}

export async function loadActiveWorkspaceToken(): Promise<StoredWorkspaceLogin | null> {
  return loadWorkspaceToken(undefined);
}

export async function storeWorkspaceToken(login: StoredWorkspaceLogin): Promise<void> {
  if (await writeWorkspaceTokenToCloudAuth(login)) return;

  const file = loginFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(login, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

export async function writeStoredWorkspaceToken(login: {
  workspaceSlug?: string;
  workspaceId?: string;
  workspace?: string;
  token: string;
  cloudUrl?: string;
  expiresAt?: string;
}): Promise<void> {
  const workspace = login.workspace ?? login.workspaceSlug ?? login.workspaceId;
  await storeWorkspaceToken({
    token: login.token,
    ...(workspace ? { workspace } : {}),
    ...(login.workspaceSlug ? { workspaceSlug: login.workspaceSlug } : {}),
    ...(login.workspaceId ? { workspaceId: login.workspaceId } : {}),
    ...(login.cloudUrl ? { cloudUrl: login.cloudUrl } : {}),
    ...(login.expiresAt ? { expiresAt: login.expiresAt } : {})
  });
}

export async function clearStoredWorkspaceToken(workspace?: string): Promise<void> {
  await clearWorkspaceTokenFromCloudAuth(workspace);
  await rm(loginFile(), { force: true });
}

async function readLoginFile(): Promise<StoredWorkspaceLogin | null> {
  const raw = await readFile(loginFile(), 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  return parseStoredLogin(raw);
}

async function readWorkspaceTokenFromCloudAuth(
  workspace?: string,
  cloudUrl?: string
): Promise<StoredWorkspaceLogin | null> {
  if (usesWorkspaceLoginFileOverride()) return null;
  if (isTruthyEnv(process.env.WORKFORCE_DISABLE_SHARED_AUTH)) return null;
  let auth = await readStoredAuth().catch(() => null);
  if (!auth) return null;

  if (isExpired(auth.accessTokenExpiresAt)) {
    try {
      auth = await refreshStoredAuth(auth);
    } catch {
      return null;
    }
  }

  const stored = auth as WorkforceStoredAuth;
  const tokens: Record<string, StoredWorkspaceLogin> = stored.workforce?.workspaceTokens ?? {};
  const active = stored.workforce?.activeWorkspace;
  const candidates = workspace
    ? [tokens[workspace], ...Object.values(tokens).filter((login) => workspaceMatches(login, workspace))]
    : [active ? tokens[active] : undefined, stored.workforceWorkspaceToken, legacyWorkspaceToken(stored)];

  return candidates.find((login) => Boolean(login)
    && cloudUrlMatches(login as StoredWorkspaceLogin, cloudUrl)
    && !isExpired((login as StoredWorkspaceLogin).expiresAt)) ?? null;
}

async function writeWorkspaceTokenToCloudAuth(login: StoredWorkspaceLogin): Promise<boolean> {
  if (usesWorkspaceLoginFileOverride()) return false;
  const auth = await readStoredAuth().catch(() => null);
  if (!auth) return false;

  const current = auth as WorkforceStoredAuth;
  const tokens: Record<string, StoredWorkspaceLogin> = { ...(current.workforce?.workspaceTokens ?? {}) };
  const workspace = storedWorkspaceName(login);
  if (!workspace) return false;

  const nextLogin = { ...login, workspace };
  for (const key of [workspace, login.workspaceSlug, login.workspaceId]) {
    if (key) tokens[key] = nextLogin;
  }

  await writeStoredAuth({
    ...current,
    workforce: {
      ...(current.workforce ?? {}),
      activeWorkspace: workspace,
      workspaceTokens: tokens
    },
    workforceWorkspaceToken: nextLogin
  } as StoredAuth);
  return true;
}

async function clearWorkspaceTokenFromCloudAuth(workspace?: string): Promise<void> {
  if (usesWorkspaceLoginFileOverride()) return;
  const auth = await readStoredAuth().catch(() => null);
  if (!auth) return;

  const current = auth as WorkforceStoredAuth;
  let tokens: Record<string, StoredWorkspaceLogin> = { ...(current.workforce?.workspaceTokens ?? {}) };
  const target = workspace?.trim();
  if (target) {
    tokens = Object.fromEntries(
      Object.entries(tokens).filter(([key, login]) => key !== target && !workspaceMatches(login, target))
    );
  } else {
    tokens = {};
  }

  const next: WorkforceStoredAuth = {
    ...current,
    workforce: {
      ...(current.workforce ?? {}),
      workspaceTokens: tokens
    }
  };
  if (!target || current.workforce?.activeWorkspace === target) {
    delete next.workforce?.activeWorkspace;
    delete next.workforceWorkspaceToken;
  }
  await writeStoredAuth(next as StoredAuth);
}

function parseStoredLogin(raw: string): StoredWorkspaceLogin | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) {
    return { token: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const token = typeof record.token === 'string'
      ? record.token
      : typeof record.accessToken === 'string'
        ? record.accessToken
        : '';
    if (!token.trim()) return null;
    const workspace = typeof record.workspace === 'string'
      ? record.workspace
      : typeof record.workspaceSlug === 'string'
        ? record.workspaceSlug
        : typeof record.workspaceId === 'string'
          ? record.workspaceId
          : undefined;
    const expiresAt = typeof record.expiresAt === 'string'
      ? record.expiresAt
      : typeof record.accessTokenExpiresAt === 'string'
        ? record.accessTokenExpiresAt
        : undefined;
    return {
      token: token.trim(),
      ...(workspace ? { workspace } : {}),
      ...(typeof record.workspaceSlug === 'string' ? { workspaceSlug: record.workspaceSlug } : {}),
      ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(typeof record.cloudUrl === 'string' ? { cloudUrl: record.cloudUrl } : {})
    };
  } catch {
    return null;
  }
}

function legacyWorkspaceToken(auth: WorkforceStoredAuth): StoredWorkspaceLogin | undefined {
  const token = auth.workspaceToken;
  if (!token) return undefined;
  return {
    token,
    ...(auth.workspace ? { workspace: auth.workspace } : {}),
    ...(auth.workspaceSlug ? { workspaceSlug: auth.workspaceSlug } : {}),
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
    cloudUrl: auth.apiUrl
  };
}

function workspaceMatches(login: StoredWorkspaceLogin, workspace: string | undefined): boolean {
  if (!workspace) return true;
  return [login.workspace, login.workspaceSlug, login.workspaceId].some((value) => value === workspace);
}

function cloudUrlMatches(login: StoredWorkspaceLogin, cloudUrl: string | undefined): boolean {
  if (!cloudUrl || !login.cloudUrl) return true;
  return normalizeUrl(login.cloudUrl) === normalizeUrl(cloudUrl);
}

function storedWorkspaceName(login: StoredWorkspaceLogin): string | undefined {
  return login.workspaceSlug ?? login.workspace ?? login.workspaceId;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const millis = Date.parse(expiresAt);
  return Number.isNaN(millis) ? false : millis <= Date.now();
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function usesWorkspaceLoginFileOverride(): boolean {
  return Boolean(process.env.WORKFORCE_LOGIN_FILE?.trim());
}
