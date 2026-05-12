import type { Daytona, Sandbox } from '@daytonaio/sdk';
import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from './types.js';

export interface DaytonaRuntimeOptions {
  daytona: Daytona;
  snapshot?: string;
  defaultHomeDir?: string;
}

export interface DaytonaAttachedSandboxOptions {
  homeDir?: string;
  workdir?: string;
  owned?: boolean;
}

interface RegisteredSandbox {
  sandbox: Sandbox;
  owned: boolean;
}

export class DaytonaRuntime implements WorkflowRuntime {
  readonly id = 'daytona';
  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: true,
    isolation: 'strong',
    persistentHandle: true,
    streamingLogs: true,
  };

  private readonly sandboxes = new Map<string, RegisteredSandbox>();
  private readonly daytona: Daytona;
  private readonly snapshot?: string;
  private readonly defaultHomeDir: string;

  constructor(options: DaytonaRuntimeOptions) {
    this.daytona = options.daytona;
    this.snapshot = options.snapshot;
    this.defaultHomeDir = options.defaultHomeDir ?? '/home/daytona';
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const sandbox = await this.createSandbox(options);
    const homeDir = await this.resolveHomeDir(sandbox);
    return this.registerSandbox(sandbox, {
      owned: true,
      homeDir,
      workdir: options.workdir,
    });
  }

  attachSandbox(sandbox: Sandbox, options: DaytonaAttachedSandboxOptions = {}): RuntimeHandle {
    return this.registerSandbox(sandbox, {
      owned: options.owned ?? false,
      homeDir: options.homeDir,
      workdir: options.workdir,
    });
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sandbox = this.requireSandbox(handle);
    const result = await sandbox.process.executeCommand(
      command,
      options.cwd,
      options.env,
      this.msToSeconds(options.timeoutMs),
    );

    return {
      output: result.result ?? '',
      exitCode: result.exitCode ?? 0,
    };
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    const sandbox = this.requireSandbox(handle);
    if (typeof source === 'string') {
      await sandbox.fs.uploadFile(source, destination);
      return;
    }
    await sandbox.fs.uploadFile(source, destination);
  }

  async downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void> {
    const sandbox = this.requireSandbox(handle);
    if (destination) {
      await sandbox.fs.downloadFile(source, destination);
      return;
    }
    return sandbox.fs.downloadFile(source);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    if (handle.homeDir) {
      return handle.homeDir;
    }

    const sandbox = this.requireSandbox(handle);
    const homeDir = await this.resolveHomeDir(sandbox);
    handle.homeDir = homeDir;
    return homeDir;
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = this.sandboxes.get(handle.id);
    if (!entry) {
      return;
    }

    if (!entry.owned) {
      // For attached (non-owned) sandboxes we never call the remote
      // delete; just drop the local registration so the caller-managed
      // resource isn't tracked here any more.
      this.sandboxes.delete(handle.id);
      return;
    }

    const client = this.daytona as unknown as {
      remove?: (sandbox: Sandbox) => Promise<void>;
      delete: (sandbox: Sandbox) => Promise<void>;
    };
    const remove = client.remove ?? client.delete;
    // Order matters: do the remote delete *first*, and only drop the
    // local map entry after it succeeds. If we dropped the entry first
    // and the remote delete then failed, the handle id would be lost
    // and the caller could not retry cleanup safely.
    await remove.call(client, entry.sandbox);
    this.sandboxes.delete(handle.id);
  }

  private async createSandbox(options: LaunchOptions): Promise<Sandbox> {
    const params = this.buildCreateParams(options);

    if (this.snapshot) {
      try {
        return await this.daytona.create({
          snapshot: this.snapshot,
          ...params,
        });
      } catch (err) {
        // Only fall back to a fresh sandbox when the snapshot itself is
        // missing. Auth/network/quota errors should bubble — otherwise
        // we silently mask real failures (a 401 ends up creating an
        // unsnapshotted sandbox under whichever credentials worked).
        if (!isSnapshotNotFoundError(err)) {
          throw err;
        }
      }
    }

    return this.daytona.create({
      language: 'typescript',
      ...params,
    });
  }

  private buildCreateParams(options: LaunchOptions): {
    envVars?: Record<string, string>;
    name?: string;
  } {
    const envVars = options.env && Object.keys(options.env).length > 0 ? options.env : undefined;
    const name = options.label?.trim() ? options.label.trim() : undefined;

    return {
      ...(envVars ? { envVars } : {}),
      ...(name ? { name } : {}),
    };
  }

  private registerSandbox(
    sandbox: Sandbox,
    options: DaytonaAttachedSandboxOptions & { owned: boolean },
  ): RuntimeHandle {
    const handle: RuntimeHandle = {
      id: sandbox.id,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };

    this.sandboxes.set(handle.id, {
      sandbox,
      owned: options.owned,
    });
    return handle;
  }

  private requireSandbox(handle: RuntimeHandle): Sandbox {
    const entry = this.sandboxes.get(handle.id);
    if (!entry) {
      throw new Error(`Runtime handle "${handle.id}" is no longer active`);
    }
    return entry.sandbox;
  }

  private async resolveHomeDir(sandbox: Sandbox): Promise<string> {
    try {
      const home = await sandbox.getUserHomeDir();
      if (home) {
        return home;
      }
    } catch {
      // fall through to default
    }

    return this.defaultHomeDir;
  }

  private msToSeconds(timeoutMs?: number): number | undefined {
    if (!timeoutMs || timeoutMs <= 0) {
      return undefined;
    }

    return Math.max(1, Math.ceil(timeoutMs / 1000));
  }
}

/**
 * Heuristic: identify Daytona errors that indicate the snapshot we asked
 * for doesn't exist (so falling back to a fresh sandbox is safe). We look
 * at the HTTP status when the SDK surfaces one, plus a few well-known
 * error-message shapes Daytona emits. Anything else propagates so the
 * caller sees the original error (auth/network/quota/etc.).
 */
function isSnapshotNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown };
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : undefined;
  if (status === 404) return true;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  if (!message) return false;
  return (
    message.includes('snapshot') &&
    (message.includes('not found') || message.includes('does not exist') || message.includes('no such'))
  );
}
