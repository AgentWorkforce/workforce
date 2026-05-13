import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import type { DeployIO } from './types.js';

/**
 * Workspace authentication primitives. The CLI layer plugs in real
 * implementations that talk to relayauth + the workforce cloud API; the
 * deploy package itself stays SDK-free so the contract is easy to mock.
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

function loginFile(): string {
  return process.env.WORKFORCE_LOGIN_FILE?.trim()
    || path.join(homedir(), '.agentworkforce', 'login.json');
}

function keychainEnabled(): boolean {
  const raw = process.env.WORKFORCE_DISABLE_KEYCHAIN?.trim().toLowerCase();
  return raw !== '1' && raw !== 'true' && raw !== 'yes';
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
  const envWorkspace = (process.env.WORKFORCE_WORKSPACE_ID ?? '').trim();
  const fromEnv = (process.env.WORKFORCE_WORKSPACE_TOKEN ?? '').trim();
  const requestedWorkspace = (args.workspace ?? '').trim();
  if (fromEnv && (requestedWorkspace || envWorkspace)) {
    return {
      token: fromEnv,
      workspace: requestedWorkspace || envWorkspace
    };
  }

  const stored = await loadWorkspaceToken(requestedWorkspace || undefined);
  if (stored) {
    return {
      token: stored.token,
      ...(storedWorkspaceName(stored) ? { workspace: storedWorkspaceName(stored) } : {})
    };
  }

  if (args.noPrompt) {
    throw new Error(
      `no workspace token resolved${requestedWorkspace ? ` for ${requestedWorkspace}` : ''}: run \`agentworkforce login\` or set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN`
    );
  }

  args.io.info('cloud: no workspace token found; run `agentworkforce login` to connect this machine');
  throw new Error(
    `no workspace token resolved${requestedWorkspace ? ` for ${requestedWorkspace}` : ''}: run \`agentworkforce login\` or set WORKFORCE_WORKSPACE_ID + WORKFORCE_WORKSPACE_TOKEN`
  );
}

export async function loadWorkspaceToken(workspace?: string): Promise<StoredWorkspaceLogin | null> {
  const fromKeychain = await readMacKeychainLogin(workspace);
  if (fromKeychain && !isExpired(fromKeychain.expiresAt)) {
    return fromKeychain;
  }

  const fromFile = await readLoginFile();
  if (fromFile && workspaceMatches(fromFile, workspace) && !isExpired(fromFile.expiresAt)) {
    return fromFile;
  }

  return null;
}

export async function loadActiveWorkspaceToken(): Promise<StoredWorkspaceLogin | null> {
  return loadWorkspaceToken(undefined);
}

export async function storeWorkspaceToken(login: StoredWorkspaceLogin): Promise<void> {
  if (await writeMacKeychainLogin(login)) return;

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
  const stored = await readLoginFile();
  await rm(loginFile(), { force: true });
  if (platform() !== 'darwin' || !keychainEnabled()) return;

  const names = new Set(['agentworkforce:active', 'agentworkforce', 'workforce']);
  const storedWorkspace = stored ? storedWorkspaceName(stored) : undefined;
  for (const candidate of [workspace, storedWorkspace]) {
    if (candidate) {
      names.add(`agentworkforce:${candidate}`);
      names.add(`workforce:${candidate}`);
    }
  }
  await Promise.all([...names].map((service) => deleteMacKeychainLogin(service)));
}

export async function loginWithBrowser(args: {
  cloudUrl: string;
  workspace: string;
  io: DeployIO;
}): Promise<StoredWorkspaceLogin> {
  const state = randomUUID();

  return await new Promise<StoredWorkspaceLogin>((resolve, reject) => {
    let settled = false;
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/callback') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }

      if (requestUrl.searchParams.get('state') !== state) {
        response.statusCode = 400;
        response.end('invalid state');
        settleError(new Error('login callback returned an invalid state'));
        return;
      }

      const error = requestUrl.searchParams.get('error');
      if (error) {
        response.statusCode = 400;
        response.end('login failed');
        settleError(new Error(error));
        return;
      }

      const token = requestUrl.searchParams.get('access_token')?.trim();
      const refreshToken = requestUrl.searchParams.get('refresh_token')?.trim() || undefined;
      const expiresAt = requestUrl.searchParams.get('access_token_expires_at')?.trim() || undefined;
      const cloudUrl = requestUrl.searchParams.get('api_url')?.trim() || args.cloudUrl;
      if (!token) {
        response.statusCode = 400;
        response.end('missing token');
        settleError(new Error('login callback did not include a workspace token'));
        return;
      }

      response.statusCode = 200;
      response.end('workforce login complete; you can close this tab');
      const login: StoredWorkspaceLogin = {
        workspace: args.workspace,
        token,
        cloudUrl,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {})
      };
      void storeWorkspaceToken(login).finally(() => settle(login));
    });

    function settle(login: StoredWorkspaceLogin): void {
      if (settled) return;
      settled = true;
      server.close();
      resolve(login);
    }

    function settleError(error: Error): void {
      if (settled) return;
      settled = true;
      server.close();
      reject(error);
    }

    server.on('error', settleError);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settleError(new Error('failed to start local login callback server'));
        return;
      }

      const callback = new URL('/callback', `http://127.0.0.1:${address.port}`);
      const loginUrl = new URL('/cli-auth', args.cloudUrl);
      loginUrl.searchParams.set('redirect_uri', callback.toString());
      loginUrl.searchParams.set('state', state);

      args.io.info(`cloud: login URL ${loginUrl.toString()}`);
      tryOpenBrowser(loginUrl.toString());
    });

    setTimeout(() => settleError(new Error('timed out waiting for workforce login')), 5 * 60_000).unref();
  });
}

async function readLoginFile(): Promise<StoredWorkspaceLogin | null> {
  const raw = await readFile(loginFile(), 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  return parseStoredLogin(raw);
}

async function readMacKeychainLogin(workspace?: string): Promise<StoredWorkspaceLogin | null> {
  if (platform() !== 'darwin' || !keychainEnabled()) return null;
  const serviceNames = [
    ...(workspace ? [`agentworkforce:${workspace}`, `workforce:${workspace}`] : []),
    'agentworkforce:active',
    'agentworkforce',
    'workforce'
  ];

  for (const service of serviceNames) {
    const stdout = await execSecurity(['find-generic-password', '-s', service, '-w']);
    const parsed = parseStoredLogin(stdout.trim());
    if (parsed && workspaceMatches(parsed, workspace)) return parsed;
    if (parsed) continue;
    if (stdout.trim() && workspace) {
      return {
        workspace,
        token: stdout.trim()
      };
    }
  }
  return null;
}

async function writeMacKeychainLogin(login: StoredWorkspaceLogin): Promise<boolean> {
  if (platform() !== 'darwin' || !keychainEnabled()) return false;
  const workspace = storedWorkspaceName(login) ?? 'default';
  const payload = JSON.stringify(login);
  const wroteWorkspace = await execSecurityOk([
    'add-generic-password',
    '-U',
    '-s',
    `agentworkforce:${workspace}`,
    '-a',
    workspace,
    '-w',
    payload
  ]);
  const wroteActive = await execSecurityOk([
    'add-generic-password',
    '-U',
    '-s',
    'agentworkforce:active',
    '-a',
    'active',
    '-w',
    payload
  ]);
  return wroteWorkspace && wroteActive;
}

function deleteMacKeychainLogin(service: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('security', ['delete-generic-password', '-s', service], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

function execSecurity(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('security', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? stdout : ''));
  });
}

function execSecurityOk(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('security', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
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

function workspaceMatches(login: StoredWorkspaceLogin, workspace: string | undefined): boolean {
  if (!workspace) return true;
  return [login.workspace, login.workspaceSlug, login.workspaceId].some((value) => value === workspace);
}

function storedWorkspaceName(login: StoredWorkspaceLogin): string | undefined {
  return login.workspaceSlug ?? login.workspace ?? login.workspaceId;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const millis = Date.parse(expiresAt);
  return Number.isNaN(millis) ? false : millis <= Date.now();
}

function tryOpenBrowser(url: string): void {
  const command = platform() === 'darwin'
    ? 'open'
    : platform() === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // The login URL was already printed; browser launch is best-effort.
  });
  child.unref();
}
