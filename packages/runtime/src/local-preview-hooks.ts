import { Buffer } from 'node:buffer';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { bindPreviewTransport, PreviewTransport, type TransportPreviewAction } from '@relayfile/relay-helpers';
import type { PreviewAction } from './run-contracts.js';
import type {
  LocalPreviewFetchRequestMessage,
  LocalPreviewFetchResponseMessage,
  LocalPreviewGuardConfig,
  LocalPreviewModelRequestMessage,
  LocalPreviewModelResponseMessage,
  LocalPreviewTransportReceipt,
  LocalPreviewTransportState,
  PreviewProcessState
} from './local-preview-contract.js';

const PREVIEW_PROCESS_STATE = Symbol.for('agentworkforce.local-preview.process-state');
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');
const http = require('node:http') as typeof import('node:http');
const https = require('node:https') as typeof import('node:https');
const net = require('node:net') as typeof import('node:net');
const tls = require('node:tls') as typeof import('node:tls');
const dgram = require('node:dgram') as typeof import('node:dgram');

type PreviewModuleState = PreviewProcessState;

export function installPreviewProcessGuards(args: {
  config: LocalPreviewGuardConfig;
  fetchFromParent: (request: LocalPreviewFetchRequestMessage) => Promise<LocalPreviewFetchResponseMessage>;
  completeModelFromParent: (request: LocalPreviewModelRequestMessage) => Promise<LocalPreviewModelResponseMessage>;
}): PreviewProcessState {
  const existing = getPreviewProcessState();
  if (existing) return existing;

  const previewTransport = new PreviewTransport();
  if (args.config.transportState) restorePreviewTransportState(previewTransport, args.config.transportState);
  const restoreTransport = bindPreviewTransport(previewTransport);
  const recordedActions: PreviewAction[] = [];
  const clockNow = args.config.clockNow;
  const now = clockNow ? () => new Date(clockNow) : () => new Date();
  const originalFetch = globalThis.fetch.bind(globalThis);
  const originalHttp = {
    request: http.request,
    get: http.get
  };
  const originalHttps = {
    request: https.request,
    get: https.get
  };
  const originalNet = {
    connect: net.connect,
    createConnection: net.createConnection,
    createServer: net.createServer
  };
  const originalTls = {
    connect: tls.connect,
    createServer: tls.createServer
  };
  const originalDgram = {
    createSocket: dgram.createSocket
  };
  const originalChildProcess = {
    exec: childProcess.exec,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    execSync: childProcess.execSync,
    fork: childProcess.fork,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync
  };

  const state: PreviewModuleState = {
    activateUserImportGuard() {
      // Permission-mode worker + patched builtins are the safety boundary.
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      http.request = originalHttp.request;
      http.get = originalHttp.get;
      https.request = originalHttps.request;
      https.get = originalHttps.get;
      net.connect = originalNet.connect;
      net.createConnection = originalNet.createConnection;
      net.createServer = originalNet.createServer;
      tls.connect = originalTls.connect;
      tls.createServer = originalTls.createServer;
      dgram.createSocket = originalDgram.createSocket;
      childProcess.exec = originalChildProcess.exec;
      childProcess.execFile = originalChildProcess.execFile;
      childProcess.execFileSync = originalChildProcess.execFileSync;
      childProcess.execSync = originalChildProcess.execSync;
      childProcess.fork = originalChildProcess.fork;
      childProcess.spawn = originalChildProcess.spawn;
      childProcess.spawnSync = originalChildProcess.spawnSync;
      syncBuiltinESMExports();
      restoreTransport();
      delete (globalThis as Record<PropertyKey, unknown>)[PREVIEW_PROCESS_STATE];
    },
    fetchFromParent: args.fetchFromParent,
    completeModelFromParent: args.completeModelFromParent,
    now,
    previewTransport: previewTransport as unknown as PreviewProcessState['previewTransport'],
    snapshotTransportState() {
      return snapshotPreviewTransportState(previewTransport);
    },
    recordAction(action) {
      recordedActions.push(action);
    },
    recordedActions
  };

  http.request = ((..._args: unknown[]) => denyRawNetwork(state, 'node:http', 'request')) as typeof http.request;
  http.get = ((..._args: unknown[]) => denyRawNetwork(state, 'node:http', 'get')) as typeof http.get;
  https.request = ((..._args: unknown[]) => denyRawNetwork(state, 'node:https', 'request')) as typeof https.request;
  https.get = ((..._args: unknown[]) => denyRawNetwork(state, 'node:https', 'get')) as typeof https.get;
  net.connect = ((..._args: unknown[]) => denyRawNetwork(state, 'node:net', 'connect')) as typeof net.connect;
  net.createConnection = ((..._args: unknown[]) => denyRawNetwork(state, 'node:net', 'createConnection')) as typeof net.createConnection;
  net.createServer = ((..._args: unknown[]) => denyRawNetwork(state, 'node:net', 'createServer')) as typeof net.createServer;
  tls.connect = ((..._args: unknown[]) => denyRawNetwork(state, 'node:tls', 'connect')) as typeof tls.connect;
  tls.createServer = ((..._args: unknown[]) => denyRawNetwork(state, 'node:tls', 'createServer')) as typeof tls.createServer;
  dgram.createSocket = ((..._args: unknown[]) => denyRawNetwork(state, 'node:dgram', 'createSocket')) as typeof dgram.createSocket;

  childProcess.exec = ((command: string, ..._args: unknown[]) => denyChildProcess(state, 'exec', command)) as unknown as typeof childProcess.exec;
  childProcess.execFile = ((file: string, ..._args: unknown[]) => denyChildProcess(state, 'execFile', file)) as unknown as typeof childProcess.execFile;
  childProcess.execFileSync = ((file: string, ..._args: unknown[]) => denyChildProcess(state, 'execFileSync', file)) as typeof childProcess.execFileSync;
  childProcess.execSync = ((command: string, ..._args: unknown[]) => denyChildProcess(state, 'execSync', command)) as typeof childProcess.execSync;
  childProcess.fork = ((modulePath: string, ..._args: unknown[]) => denyChildProcess(state, 'fork', modulePath)) as typeof childProcess.fork;
  childProcess.spawn = ((command: string, ..._args: unknown[]) => denyChildProcess(state, 'spawn', command)) as typeof childProcess.spawn;
  childProcess.spawnSync = ((command: string, ..._args: unknown[]) => denyChildProcess(state, 'spawnSync', command)) as typeof childProcess.spawnSync;

  syncBuiltinESMExports();
  globalThis.fetch = installFetchBridge(state);
  (globalThis as Record<PropertyKey, unknown>)[PREVIEW_PROCESS_STATE] = state;
  return state;
}

function snapshotPreviewTransportState(previewTransport: PreviewTransport): LocalPreviewTransportState {
  const internal = previewTransport as unknown as {
    sequence: number;
    data: Map<string, unknown>;
    writtenPaths: Set<string>;
    receiptsByReference: Map<string, LocalPreviewTransportReceipt>;
  };
  return {
    sequence: internal.sequence ?? 0,
    data: Object.fromEntries((internal.data ?? new Map()).entries()),
    writtenPaths: [...(internal.writtenPaths ?? new Set())],
    receiptsByReference: Object.fromEntries((internal.receiptsByReference ?? new Map()).entries())
  };
}

function restorePreviewTransportState(
  previewTransport: PreviewTransport,
  state: LocalPreviewTransportState
): void {
  const internal = previewTransport as unknown as {
    sequence: number;
    data: Map<string, unknown>;
    writtenPaths: Set<string>;
    receiptsByReference: Map<string, LocalPreviewTransportReceipt>;
  };
  internal.sequence = state.sequence;
  internal.data = new Map(Object.entries(state.data ?? {}));
  internal.writtenPaths = new Set(state.writtenPaths ?? []);
  internal.receiptsByReference = new Map(Object.entries(state.receiptsByReference ?? {}));
}

export function getPreviewProcessState(): PreviewProcessState | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[PREVIEW_PROCESS_STATE] as
    | PreviewProcessState
    | undefined;
}

export function transportActionToPreviewAction(action: TransportPreviewAction): PreviewAction {
  return {
    kind: action.kind,
    status: action.status,
    provider: action.provider,
    resource: action.resource,
    ...(action.id ? { id: action.id } : {}),
    data: {
      ...action.data,
      ...(action.method ? { method: action.method } : {}),
      ...(action.path ? { path: action.path } : {}),
      ...(action.parameters ? { parameters: action.parameters } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
      ...(action.simulatedReceipt ? { simulatedReceipt: action.simulatedReceipt } : {})
    }
  };
}

function installFetchBridge(state: PreviewProcessState): typeof globalThis.fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = toRequest(input, init);
    const message: LocalPreviewFetchRequestMessage = {
      type: 'fetch',
      requestId: `fetch_${Math.random().toString(16).slice(2, 10)}`,
      method: request.method.toUpperCase(),
      url: request.url,
      headers: [...request.headers.entries()],
      ...(request.method !== 'GET' && request.method !== 'HEAD'
        ? { bodyBase64: Buffer.from(await request.arrayBuffer()).toString('base64') }
        : {})
    };
    const response = await state.fetchFromParent(message);
    state.recordAction(response.action);
    if (!response.ok || !response.response) {
      throw new Error(response.error ?? `invoke parent fetch bridge failed for ${request.method} ${request.url}`);
    }
    return new Response(Buffer.from(response.response.bodyBase64, 'base64'), {
      status: response.response.status,
      headers: response.response.headers
    });
  }) as typeof globalThis.fetch;
}

function denyRawNetwork(state: PreviewProcessState, moduleName: string, call: string): never {
  state.recordAction({
    kind: 'http.read',
    status: 'denied',
    data: {
      module: moduleName,
      call
    }
  });
  throw new Error(`invoke: preview worker denied raw network ${moduleName}.${call}`);
}

function denyChildProcess(state: PreviewProcessState, call: string, cmd?: unknown): never {
  state.recordAction({
    kind: 'shell.exec',
    status: 'denied',
    data: {
      call,
      ...(cmd !== undefined ? { cmd: stringifyCommand(cmd) } : {})
    }
  });
  throw new Error(`invoke: preview worker denied child_process.${call}`);
}

function stringifyCommand(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toRequest(input: URL | RequestInfo, init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init);
  if (input instanceof URL) return new Request(input, init);
  return new Request(input, init);
}
