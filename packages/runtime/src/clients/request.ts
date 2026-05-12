import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceIntegrationError } from '../errors.js';

export interface IntegrationClientOptions {
  relayfileMountRoot?: string;
  relayfileRoot?: string;
  mountRoot?: string;
  workspaceCwd?: string;
  writebackTimeoutMs?: number;
  writebackPollMs?: number;
  connectionId?: string;
  relayfileBaseUrl?: string;
  relayfileApiToken?: string;
  cloudApiToken?: string;
  workspaceId?: string;
  slackTeamId?: string;
}

export interface WritebackReceipt {
  created?: string;
  path?: string;
  url?: string;
  id?: string;
  [key: string]: unknown;
}

export interface WritebackResult {
  path: string;
  absolutePath: string;
  receipt?: WritebackReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function draftFile(prefix: string): string {
  return `${prefix} ${randomUUID()}.json`;
}

export function resolveMountRoot(client: IntegrationClientOptions): string {
  return path.resolve(
    client.relayfileMountRoot ??
      client.relayfileRoot ??
      client.mountRoot ??
      process.env.RELAYFILE_MOUNT_ROOT ??
      process.env.RELAYFILE_ROOT ??
      client.workspaceCwd ??
      process.cwd()
  );
}

function toAbsolutePath(client: IntegrationClientOptions, relayPath: string): string {
  const root = resolveMountRoot(client);
  const normalized = relayPath.startsWith('/') ? relayPath.slice(1) : relayPath;
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Relayfile path escapes mount root: ${relayPath}`);
  }
  return absolute;
}

export async function readJsonFile<T>(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayPath: string
): Promise<T> {
  try {
    const absolutePath = toAbsolutePath(client, relayPath);
    return JSON.parse(await readFile(absolutePath, 'utf8')) as T;
  } catch (cause) {
    throw new WorkforceIntegrationError({ provider, operation, cause, retryable: false });
  }
}

export async function listJsonFiles<T>(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayDir: string
): Promise<Array<{ path: string; value: T }>> {
  try {
    const absoluteDir = toAbsolutePath(client, relayDir);
    const entries = await readdir(absoluteDir).catch(() => []);
    const out: Array<{ path: string; value: T }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const relayPath = `${relayDir.replace(/\/+$/, '')}/${entry}`;
      const value = JSON.parse(await readFile(path.join(absoluteDir, entry), 'utf8')) as T;
      out.push({ path: relayPath, value });
    }
    return out;
  } catch (cause) {
    throw new WorkforceIntegrationError({ provider, operation, cause, retryable: false });
  }
}

export async function writeJsonFile(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayPath: string,
  body: unknown
): Promise<WritebackResult> {
  try {
    const absolutePath = toAbsolutePath(client, relayPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const tempPath = `${absolutePath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(tempPath, absolutePath);
    const receipt = await waitForReceipt(absolutePath, client);
    return { path: relayPath, absolutePath, ...(receipt ? { receipt } : {}) };
  } catch (cause) {
    throw new WorkforceIntegrationError({ provider, operation, cause, retryable: false });
  }
}

async function waitForReceipt(
  absolutePath: string,
  client: IntegrationClientOptions
): Promise<WritebackReceipt | undefined> {
  const timeoutMs = client.writebackTimeoutMs ?? 0;
  const deadline = Date.now() + timeoutMs;
  do {
    const parsed = await readCurrentJson(absolutePath);
    if (
      isRecord(parsed) &&
      (typeof parsed.created === 'string' ||
        typeof parsed.path === 'string' ||
        typeof parsed.id === 'string')
    ) {
      return parsed as WritebackReceipt;
    }
    if (timeoutMs <= 0) return undefined;
    await new Promise((resolve) => setTimeout(resolve, client.writebackPollMs ?? 250));
  } while (Date.now() < deadline);
  return undefined;
}

async function readCurrentJson(absolutePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}
