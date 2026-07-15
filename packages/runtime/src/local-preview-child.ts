import type {
  LocalPreviewFetchRequestMessage,
  LocalPreviewFetchResponseMessage,
  LocalPreviewWorkerInboundMessage,
  LocalPreviewWorkerInitMessage,
  LocalPreviewWorkerReadyMessage,
  LocalPreviewWorkerResult,
  LocalPreviewWorkerResultMessage
} from './local-preview-contract.js';
import { executeLocalRunInWorkerProcess } from './local-preview-executor.js';
import { getPreviewProcessState, installPreviewProcessGuards } from './local-preview-hooks.js';

const pendingFetches = new Map<string, {
  resolve: (value: LocalPreviewFetchResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
const LOCAL_PREVIEW_FETCH_IPC_TIMEOUT_MS = readTimeoutEnv('WF_LOCAL_PREVIEW_FETCH_TIMEOUT_MS', 10_000);

process.on('message', (message: LocalPreviewWorkerInboundMessage) => {
  if (message?.type === 'fetch-response') {
    resolvePendingFetch(message);
  }
});

process.on('disconnect', () => {
  for (const pending of pendingFetches.values()) {
    pending.reject(new Error('invoke: preview worker parent disconnected during fetch'));
  }
  pendingFetches.clear();
});

await sendReady();
const init = await receiveInitMessage();
installPreviewProcessGuards({
  config: init.config,
  fetchFromParent: sendFetchToParent
});

try {
  const result = await executeLocalRunInWorkerProcess(init.payload);
  await sendResult({
    ok: true,
    ...result
  });
} catch (error) {
  await sendResult({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  });
  process.exitCode = 1;
} finally {
  getPreviewProcessState()?.cleanup();
  process.disconnect?.();
}

function receiveInitMessage(): Promise<LocalPreviewWorkerInitMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: LocalPreviewWorkerInboundMessage) => {
      if (!message) return;
      if (message.type === 'init') {
        cleanup();
        resolve(message);
        return;
      }
      if (message.type === 'fetch-response') {
        resolvePendingFetch(message);
      }
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('invoke: preview worker parent disconnected before init'));
    };
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

function sendFetchToParent(
  request: LocalPreviewFetchRequestMessage
): Promise<LocalPreviewFetchResponseMessage> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('invoke: preview worker missing parent IPC channel'));
      return;
    }
    const timeout = setTimeout(() => {
      pendingFetches.delete(request.requestId);
      reject(new Error(
        `invoke: preview worker fetch IPC timeout after ${LOCAL_PREVIEW_FETCH_IPC_TIMEOUT_MS}ms for ${request.method} ${request.url}`
      ));
    }, LOCAL_PREVIEW_FETCH_IPC_TIMEOUT_MS);
    pendingFetches.set(request.requestId, { resolve, reject, timeout });
    process.send(request, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      pendingFetches.delete(request.requestId);
      reject(error);
    });
  });
}

async function sendReady(): Promise<void> {
  if (typeof process.send !== 'function') {
    throw new Error('invoke: preview worker missing parent IPC channel');
  }
  const message: LocalPreviewWorkerReadyMessage = { type: 'ready' };
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sendResult(result: LocalPreviewWorkerResult): Promise<void> {
  if (typeof process.send !== 'function') {
    throw new Error('invoke: preview worker missing parent IPC channel');
  }
  const message: LocalPreviewWorkerResultMessage = {
    type: 'result',
    result
  };
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resolvePendingFetch(message: LocalPreviewFetchResponseMessage): void {
  const pending = pendingFetches.get(message.requestId);
  if (!pending) return;
  pendingFetches.delete(message.requestId);
  clearTimeout(pending.timeout);
  pending.resolve(message);
}

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
