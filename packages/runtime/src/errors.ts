export interface WorkforceIntegrationErrorOptions {
  provider: string;
  operation: string;
  cause?: unknown;
  retryable?: boolean;
}

export class WorkforceIntegrationError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(options: WorkforceIntegrationErrorOptions) {
    super(`${options.provider} ${options.operation} failed`);
    this.name = 'WorkforceIntegrationError';
    this.provider = options.provider;
    this.operation = options.operation;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }
}
