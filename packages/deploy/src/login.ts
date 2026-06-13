import {
  CloudAuthError,
  ensureCloudSession,
  resolveActiveWorkspace,
  type ActiveWorkspaceDescriptor
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
    relayfileWorkspaceId?: string;
    /** Workspace-scoped token usable for gateway + cloud API calls. */
    token: string;
  }>;
}

export interface WorkspaceAuthToken {
  token: string;
  workspace?: string;
  relayfileWorkspaceId?: string;
  workspaceDescriptor?: ActiveWorkspaceDescriptor;
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

/**
 * Deprecated compatibility type. Workspace selection now lives in
 * @agent-relay/cloud's canonical workspace store.
 */
export interface ActiveWorkspacePointer {
  workspace: string;
  workspaceSlug?: string;
  workspaceId?: string;
  cloudUrl?: string;
  setAt: string;
}

export async function readActiveWorkspace(): Promise<ActiveWorkspacePointer | null> {
  return null;
}

export async function writeActiveWorkspace(
  _input: Omit<ActiveWorkspacePointer, 'setAt'>
): Promise<void> {
  // No-op: agentworkforce no longer owns a separate active.json pin.
}

export async function clearActiveWorkspace(): Promise<void> {
  // No-op: agentworkforce no longer owns a separate active.json pin.
}

/**
 * Environment-backed fallback resolver: reads `WORKFORCE_WORKSPACE_ID`
 * and `WORKFORCE_WORKSPACE_TOKEN` from `process.env`. Useful in CI and as
 * an explicit override before falling back to the canonical relay session.
 */
export function envWorkspaceAuth(): WorkspaceAuth {
  return {
    async resolveWorkspace({ override, io }) {
      const workspace = (override ?? process.env.WORKFORCE_WORKSPACE_ID ?? '').trim();
      const token = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
      if (workspace && token) {
        return { workspace, token };
      }

      if (!workspace) {
        io.error(
          'no workspace resolved: pass --workspace, set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN, or run `agent-relay workspace switch <name>`'
        );
        throw new Error('workspace is required for deploy');
      }

      io.error(
        `no workspace token resolved for ${workspace}: set WORKFORCE_WORKSPACE_TOKEN, or use the canonical agent-relay session`
      );
      throw new Error('workspace token is required for deploy');
    }
  };
}

/**
 * Resolve the cloud bearer and canonical active relay workspace. CI may still
 * provide WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN explicitly; all
 * interactive/user-machine auth flows go through @agent-relay/cloud.
 */
export function resolveWorkspaceTokenFromEnv(workspace: string): WorkspaceAuthToken {
  const token = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      `no workspace token resolved for ${workspace}: run \`agent-relay login\` or set WORKFORCE_WORKSPACE_TOKEN`
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
  const cloudUrl = canonicalizeCloudUrl(args.cloudUrl);
  const envWorkspace = (process.env.WORKFORCE_WORKSPACE_ID ?? '').trim();
  const envToken = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
  const requestedWorkspace = (args.workspace ?? '').trim();

  if (envToken && (requestedWorkspace || envWorkspace)) {
    return {
      token: envToken,
      workspace: requestedWorkspace || envWorkspace
    };
  }

  const session = await ensureCloudSession({
    apiUrl: cloudUrl,
    interactive: false
  }).catch((error) => {
    throw workspaceAuthError(error);
  });
  const descriptor = await resolveWorkspaceDescriptor({
    requestedWorkspace: requestedWorkspace || envWorkspace,
    apiUrl: session.auth.apiUrl || cloudUrl
  });

  return {
    token: session.auth.accessToken,
    workspace: descriptor.relaycastWorkspaceId,
    relayfileWorkspaceId: descriptor.relayfileWorkspaceId,
    workspaceDescriptor: descriptor
  };
}

async function resolveWorkspaceDescriptor(args: {
  requestedWorkspace?: string;
  apiUrl: string;
}): Promise<ActiveWorkspaceDescriptor> {
  const workspace = args.requestedWorkspace?.trim();
  if (!workspace) {
    return resolveActiveWorkspace({
      apiUrl: args.apiUrl,
      interactive: false
    });
  }

  const session = await ensureCloudSession({
    apiUrl: args.apiUrl,
    interactive: false
  });
  const response = await session.client.fetch(
    `/api/v1/workspaces/${encodeURIComponent(workspace)}/resolve`,
    { method: 'GET' }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`workspace resolve failed for ${workspace}: ${response.status} ${text}`.trim());
  }
  const payload = await response.json().catch(() => null);
  return normalizeWorkspaceDescriptor(payload, session.auth.apiUrl || args.apiUrl);
}

function normalizeWorkspaceDescriptor(payload: unknown, apiUrl: string): ActiveWorkspaceDescriptor {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('workspace resolve returned an invalid descriptor');
  }
  const record = payload as Record<string, unknown>;
  const urls = record.urls && typeof record.urls === 'object' && !Array.isArray(record.urls)
    ? record.urls as Record<string, unknown>
    : {};
  const key = readString(record, 'key') ?? readString(record, 'relaycastApiKey') ?? '';
  const relaycastWorkspaceId = readString(record, 'relaycastWorkspaceId')
    ?? readString(record, 'workspaceId')
    ?? '';
  const relayfileWorkspaceId = readString(record, 'relayfileWorkspaceId') ?? '';
  const relayauthWorkspaceId = readString(record, 'relayauthWorkspaceId') ?? '';
  if (!key || !relaycastWorkspaceId || !relayfileWorkspaceId || !relayauthWorkspaceId) {
    throw new Error('workspace resolve returned an incomplete descriptor');
  }
  return {
    key,
    cloudWorkspaceId: readString(record, 'cloudWorkspaceId') ?? relaycastWorkspaceId,
    relaycastWorkspaceId,
    ...(readString(record, 'relaycastApiKey')
      ? { relaycastApiKey: readString(record, 'relaycastApiKey') }
      : {}),
    relayfileWorkspaceId,
    relayauthWorkspaceId,
    ...(readString(record, 'organizationId')
      ? { organizationId: readString(record, 'organizationId') }
      : {}),
    ...(readString(record, 'slug') ? { slug: readString(record, 'slug') } : {}),
    ...(readString(record, 'name') ? { name: readString(record, 'name') } : {}),
    urls: {
      relaycastUrl: readString(urls, 'relaycastUrl') ?? '',
      relayfileUrl: readString(urls, 'relayfileUrl') ?? '',
      relayauthUrl: readString(urls, 'relayauthUrl') ?? ''
    },
    apiUrl,
    ...(typeof record.provisioned === 'boolean' ? { provisioned: record.provisioned } : {})
  };
}

export async function loadWorkspaceToken(
  _workspace?: string,
  _cloudUrl?: string
): Promise<StoredWorkspaceLogin | null> {
  return null;
}

export async function loadActiveWorkspaceToken(): Promise<StoredWorkspaceLogin | null> {
  return null;
}

export async function storeWorkspaceToken(_login: StoredWorkspaceLogin): Promise<void> {
  throw new Error('workspace token storage has moved to the canonical agent-relay cloud session');
}

export async function writeStoredWorkspaceToken(_login: {
  workspaceSlug?: string;
  workspaceId?: string;
  workspace?: string;
  token: string;
  cloudUrl?: string;
  expiresAt?: string;
}): Promise<void> {
  throw new Error('workspace token storage has moved to the canonical agent-relay cloud session');
}

export async function clearStoredWorkspaceToken(_workspace?: string): Promise<void> {
  // No-op: old login.json and cloud-auth workforce.workspaceTokens are no
  // longer written by this package.
}

function workspaceAuthError(error: unknown): Error {
  if (error instanceof CloudAuthError) {
    switch (error.code) {
      case 'AUTH_REFRESH_TIMEOUT':
        return new Error(`cloud auth refresh timed out: ${error.message}`);
      case 'AUTH_REFRESH_EXPIRED':
      case 'AUTH_BROWSER_REQUIRED':
      case 'AUTH_ENV_REPROVISION_REQUIRED':
        if (/agent-relay login/i.test(error.message)) {
          return new Error(error.message);
        }
        return new Error(`${error.message}. Run \`agent-relay login\` and retry.`);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
