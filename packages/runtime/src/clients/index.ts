import * as adapterVfsClient from '@relayfile/adapter-core/vfs-client';
import {
  writeJsonFile as coreWriteJsonFile,
  RelayfileWritebackError,
  type IntegrationClientOptions,
  type WritebackReceipt,
  type WritebackResult
} from '@relayfile/adapter-core/vfs-client';

// Shared VFS-backed transport surface. All provider interactions go through
// these helpers — no per-provider client code lives in the runtime.
//
// The transport itself now lives in the relayfile layer
// (`@relayfile/adapter-core/vfs-client`) — it's the generic Relayfile
// draft-write protocol, not anything workforce-specific. The runtime re-exports
// it so existing handlers that `import … from '@agentworkforce/runtime/clients'`
// keep working unchanged. The ergonomic per-provider clients live in
// `@relayfile/relay-helpers`.
export {
  draftFile,
  encodeSegment,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  resolveMountRoot,
  RelayfileWritebackError,
  type RelayfileWritebackErrorOptions,
  type IntegrationClientOptions,
  type WritebackReceipt,
  type WritebackResult
} from '@relayfile/adapter-core/vfs-client';

export {
  WorkforceIntegrationError,
  type WorkforceIntegrationErrorOptions,
  SandboxNotAvailableError
} from '../errors.js';

export type NormalizedWritebackState =
  | 'succeeded'
  | 'no_receipt'
  | 'validation_failed'
  | 'readonly_rejected'
  | 'adapter_error'
  | 'ok';

export interface NormalizedWritebackStatus {
  state: NormalizedWritebackState;
  path: string;
  op?: 'create' | 'patch' | 'delete';
  id?: string;
  error?: string;
  field?: string;
  receipt?: WritebackReceipt;
  timestamp?: string;
  entry?: unknown;
}

type AdapterVfsClientExtensions = {
  normalizeWritebackStatus?: (
    result?: WritebackResult,
    entry?: unknown
  ) => NormalizedWritebackStatus;
  WritebackError?: new (normalized: NormalizedWritebackStatus) => RelayfileWritebackError &
    NormalizedWritebackStatus;
};

class FallbackWritebackError extends RelayfileWritebackError {
  readonly state: NormalizedWritebackState;
  readonly path: string;
  readonly op?: 'create' | 'patch' | 'delete';
  readonly id?: string;
  readonly receipt?: WritebackReceipt;
  readonly error?: string;
  readonly field?: string;
  readonly timestamp?: string;

  constructor(normalized: NormalizedWritebackStatus) {
    super({
      provider: 'writeback',
      operation: normalized.state,
      cause: normalized.error ? new Error(normalized.error) : undefined,
      retryable: false
    });
    this.name = 'WritebackError';
    this.message = `writeback ${normalized.state} ${normalized.path}${
      normalized.error ? `: ${normalized.error}` : ''
    }`;
    this.state = normalized.state;
    this.path = normalized.path;
    this.op = normalized.op;
    this.id = normalized.id;
    this.receipt = normalized.receipt;
    this.error = normalized.error;
    this.field = normalized.field;
    this.timestamp = normalized.timestamp;
  }
}

const adapterExtensions = adapterVfsClient as AdapterVfsClientExtensions;

export const WritebackError = adapterExtensions.WritebackError ?? FallbackWritebackError;

export function normalizeWritebackStatus(
  result?: WritebackResult,
  entry?: unknown
): NormalizedWritebackStatus {
  const normalize = adapterExtensions.normalizeWritebackStatus;
  if (normalize) return normalize(result, entry);

  if (!result?.receipt) {
    return {
      state: 'no_receipt',
      path: result?.path ?? '',
      error: 'writeback produced no receipt'
    };
  }

  const receipt = result.receipt;
  const id =
    receipt.id !== undefined
      ? String(receipt.id)
      : receipt.created !== undefined
        ? String(receipt.created)
        : undefined;
  return {
    state: 'succeeded',
    path: result.path,
    ...(id ? { id } : {}),
    receipt
  };
}

export async function writeJsonFile(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayPath: string,
  body: unknown
): Promise<WritebackResult> {
  const result = await coreWriteJsonFile(client, provider, operation, relayPath, body);
  const normalized = normalizeWritebackStatus(result);
  if (normalized.state !== 'succeeded') {
    if (client.writebackTimeoutMs === 0 && normalized.state === 'no_receipt') {
      return result;
    }
    throw new WritebackError(normalized);
  }
  return result;
}
