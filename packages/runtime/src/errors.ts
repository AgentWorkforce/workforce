/**
 * Error type every integration client throws when a remote write or read
 * fails. Lives at the package root rather than inside `clients/` so the
 * persona's handler can `import { WorkforceIntegrationError }` without
 * reaching into a subpath that may evolve.
 *
 * The error carries enough metadata for the runtime's retry layer to
 * make decisions without parsing message strings:
 *
 *   - `provider` — `github` / `linear` / `slack` / …
 *   - `operation` — the client method that failed (`comment`,
 *     `upsertIssue.create`, …)
 *   - `retryable` — `true` for transient failures (the runtime resends
 *     the originating event); `false` for permanent shape/validation
 *     failures that won't change on retry
 *   - `cause` — the original thrown value, preserved for logs
 */
export interface WorkforceIntegrationErrorOptions {
  provider: string;
  operation: string;
  cause?: unknown;
  retryable?: boolean;
}

export class WorkforceIntegrationError extends Error {
  readonly provider: string;
  readonly operation: string;
  override readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(options: WorkforceIntegrationErrorOptions) {
    super(`${options.provider}.${options.operation} failed${
      options.cause instanceof Error ? `: ${options.cause.message}` : ''
    }`);
    this.name = 'WorkforceIntegrationError';
    this.provider = options.provider;
    this.operation = options.operation;
    if (options.cause !== undefined) this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Thrown when handler code calls `ctx.sandbox.exec()` on a persona that
 * declared `sandbox: 'optional'` or `sandbox: false`. Refactor the handler
 * to use provider client list methods (`ctx.linear.listProjects()`,
 * `ctx.gmail.listThreads()`, etc.) instead of `find` + `read` loops.
 */
export class SandboxNotAvailableError extends Error {
  constructor(operation?: string) {
    super(
      operation
        ? `sandbox.exec('${operation}') is not available: persona uses sandbox:'optional'. Use provider list methods (e.g. ctx.linear.listProjects()) instead of ctx.sandbox.exec(find ...)`
        : `sandbox.exec() is not available: persona uses sandbox:'optional'. Use provider list methods instead of ctx.sandbox.exec(find ...)`
    );
    this.name = 'SandboxNotAvailableError';
  }
}
