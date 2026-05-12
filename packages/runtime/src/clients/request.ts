import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceIntegrationError } from '../errors.js';

/**
 * Shared VFS-backed transport for every workforce integration client.
 *
 * Workforce integration clients do not call provider REST APIs
 * directly. Instead they read and write JSON files at canonical paths
 * inside a Relayfile mount (`/<provider>/<resource>/<id>.json`). A
 * Relayfile writeback worker picks up the draft files and turns them
 * into real provider calls, then writes a receipt back to the same
 * path. This matches the rest of the workforce/cloud stack (sage,
 * workflows) and gets writeback durability + retry semantics for free.
 *
 * The handler-side ergonomics stay identical to the direct-REST shape
 * — `await ctx.github.comment(target, body)` returns when the write
 * lands. Whether the receipt is awaited synchronously, polled, or
 * fired-and-forgotten depends on `writebackTimeoutMs`.
 */
export interface IntegrationClientOptions {
  /** Absolute path to the Relayfile mount the handler is running in. */
  relayfileMountRoot?: string;
  /** @deprecated alias for {@link relayfileMountRoot}. */
  relayfileRoot?: string;
  /** @deprecated alias for {@link relayfileMountRoot}. */
  mountRoot?: string;
  /** Working directory fallback when no mount root is configured. */
  workspaceCwd?: string;
  /**
   * Max wait, in ms, for the Relayfile writeback worker to emit a
   * receipt onto the just-written draft. `0` (default) means
   * fire-and-forget — the client returns immediately and the receipt
   * is whatever was readable at write time.
   */
  writebackTimeoutMs?: number;
  /** Poll interval while waiting for a receipt. Default 250ms. */
  writebackPollMs?: number;
  /** Relayfile connection id, if the writeback needs one. */
  connectionId?: string;
  /** Direct Relayfile API base URL, when the client talks to it out-of-band. */
  relayfileBaseUrl?: string;
  /** API token for the Relayfile API, when applicable. */
  relayfileApiToken?: string;
  /** Workforce cloud API token, for cross-service auth (slack, jira). */
  cloudApiToken?: string;
  /** Workspace id the handler is bound to. */
  workspaceId?: string;
  /** Slack team id, when the client targets a specific workspace. */
  slackTeamId?: string;
}

/**
 * Shape of the JSON the Relayfile writeback worker writes back into a
 * draft file once the remote write completes. Clients read this back
 * to populate their return values (issue numbers, comment ids, etc.).
 */
export interface WritebackReceipt {
  created?: string;
  path?: string;
  url?: string;
  id?: string;
  identifier?: string;
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

/** Percent-encode a path segment so identifiers safely round-trip. */
export function encodeSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Allocate a unique draft filename for a new resource. The Relayfile
 * writeback worker renames the file to the canonical id on receipt.
 */
export function draftFile(prefix: string): string {
  return `${prefix} ${randomUUID()}.json`;
}

/**
 * Resolve the absolute Relayfile mount root, honoring (in order) the
 * client-supplied option, the `RELAYFILE_MOUNT_ROOT` / `RELAYFILE_ROOT`
 * env vars, and finally `workspaceCwd` / `process.cwd()`.
 */
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

export async function readTextFile(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayPath: string
): Promise<string> {
  try {
    return await readFile(toAbsolutePath(client, relayPath), 'utf8');
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
    const entries = await readdirIfPresent(absoluteDir);
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

export async function listDirectoryEntries(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayDir: string
): Promise<string[]> {
  try {
    return await readdirIfPresent(toAbsolutePath(client, relayDir));
  } catch (cause) {
    throw new WorkforceIntegrationError({ provider, operation, cause, retryable: false });
  }
}

async function readdirIfPresent(absoluteDir: string): Promise<string[]> {
  try {
    return await readdir(absoluteDir);
  } catch (error) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}

function isNoEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Write a draft JSON payload atomically (write-then-rename) so the
 * writeback worker never sees a partial file. Waits for a receipt
 * when `writebackTimeoutMs > 0`; otherwise returns immediately.
 */
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
