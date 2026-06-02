/**
 * Error every integration read/write throws on failure. The class now lives
 * with the transport in `@relayfile/adapter-core/vfs-client` as
 * `RelayfileWritebackError`; `WorkforceIntegrationError` is kept as an **alias
 * of the same class** (not a subclass) so existing handlers that
 * `catch (e) { if (e instanceof WorkforceIntegrationError) … }` still match
 * what the relocated transport throws. Same `{ provider, operation, cause,
 * retryable }` shape.
 */
export {
  RelayfileWritebackError,
  RelayfileWritebackError as WorkforceIntegrationError,
  type RelayfileWritebackErrorOptions,
  type RelayfileWritebackErrorOptions as WorkforceIntegrationErrorOptions
} from '@relayfile/adapter-core/vfs-client';

/**
 * Thrown when handler code calls `ctx.sandbox.exec()` on a persona that
 * declared `sandbox: false`. Refactor the handler to use VFS helpers
 * (listJsonFiles / readJsonFile / writeJsonFile) against the provider
 * path conventions instead of exec-based find + read loops.
 */
export class SandboxNotAvailableError extends Error {
  constructor(operation?: string) {
    super(
      operation
        ? `sandbox.exec('${operation}') is not available: persona uses sandbox: false. Use VFS helpers (listJsonFiles / readJsonFile) against provider paths instead.`
        : `sandbox.exec() is not available: persona uses sandbox: false. Use VFS helpers against provider paths instead.`
    );
    this.name = 'SandboxNotAvailableError';
  }
}
