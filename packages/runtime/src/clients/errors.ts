/**
 * Error thrown by every integration client when a remote call fails. The
 * runtime's retry loop reads `retryable` to decide whether to redeliver
 * the event; tests + handlers can branch on `provider` + `operation` for
 * targeted recovery without parsing message strings.
 */
export class WorkforceIntegrationError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly status?: number;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(opts: {
    provider: string;
    operation: string;
    message: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(`${opts.provider}.${opts.operation}: ${opts.message}`);
    this.name = 'WorkforceIntegrationError';
    this.provider = opts.provider;
    this.operation = opts.operation;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** 5xx and 429 responses are retryable; 4xx (other than 429) are not. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
