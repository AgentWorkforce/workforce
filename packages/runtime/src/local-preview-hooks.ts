import { fileURLToPath } from 'node:url';
import Module, { createRequire, registerHooks } from 'node:module';
import { bindPreviewTransport, PreviewTransport, type TransportPreviewAction } from '@relayfile/relay-helpers';
import type { PreviewAction } from './run-contracts.js';
import type {
  LocalPreviewGuardConfig,
  PreviewProcessState
} from './local-preview-contract.js';

const PREVIEW_PROCESS_STATE = Symbol.for('agentworkforce.local-preview.process-state');
const MAX_REDIRECTS = 8;
const TRUSTED_WORKER_ROOT = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');
const FORBIDDEN_IMPORT_SPECIFIERS = new Map<string, string>([
  ['http', 'http'],
  ['node:http', 'node:http'],
  ['https', 'https'],
  ['node:https', 'node:https'],
  ['net', 'net'],
  ['node:net', 'node:net'],
  ['tls', 'tls'],
  ['node:tls', 'node:tls'],
  ['dgram', 'dgram'],
  ['node:dgram', 'node:dgram'],
  ['child_process', 'child_process'],
  ['node:child_process', 'node:child_process']
]);

type PreviewModuleState = PreviewProcessState & {
  deregisterHooks: () => void;
  guardActive: boolean;
};

export function installPreviewProcessGuards(
  config: LocalPreviewGuardConfig
): PreviewProcessState {
  const existing = getPreviewProcessState();
  if (existing) return existing;

  const previewTransport = new PreviewTransport();
  const restoreTransport = bindPreviewTransport(previewTransport);
  const recordedActions: PreviewAction[] = [];
  const clockNow = config.clockNow;
  const now = clockNow ? () => new Date(clockNow) : () => new Date();
  const moduleFacade = Module as unknown as {
    _load: (
      request: string,
      parent: NodeJS.Module | null | undefined,
      isMain: boolean
    ) => unknown;
  };
  const originalLoad = moduleFacade._load;
  const originalChildProcess = {
    exec: childProcess.exec,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    execSync: childProcess.execSync,
    fork: childProcess.fork,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync
  };
  const originalFetch = globalThis.fetch.bind(globalThis);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      assertAllowedModule(specifier, context.parentURL);
      return nextResolve(specifier, context);
    }
  });

  moduleFacade._load = ((request: string, parent: NodeJS.Module | null | undefined, isMain: boolean) => {
    assertAllowedModule(
      request,
      typeof parent?.filename === 'string' ? parent.filename : typeof parent?.id === 'string' ? parent.id : undefined
    );
    return originalLoad.call(moduleFacade, request, parent, isMain);
  }) as typeof moduleFacade._load;

  const denyChildProcess = (call: string, cmd?: unknown): never => {
    state.recordAction({
      kind: 'shell.exec',
      status: 'denied',
      data: {
        call,
        ...(cmd !== undefined ? { cmd: stringifyCommand(cmd) } : {})
      }
    });
    throw new Error(`invoke: preview worker denied child_process.${call}`);
  };

  const state: PreviewModuleState = {
    activateUserImportGuard() {
      state.guardActive = true;
    },
    now,
    previewTransport: previewTransport as unknown as PreviewProcessState['previewTransport'],
    recordedActions,
    guardActive: false,
    recordAction(action) {
      recordedActions.push(action);
    },
    deregisterHooks: () => hook.deregister(),
    cleanup() {
      globalThis.fetch = originalFetch;
      moduleFacade._load = originalLoad;
      childProcess.exec = originalChildProcess.exec;
      childProcess.execFile = originalChildProcess.execFile;
      childProcess.execFileSync = originalChildProcess.execFileSync;
      childProcess.execSync = originalChildProcess.execSync;
      childProcess.fork = originalChildProcess.fork;
      childProcess.spawn = originalChildProcess.spawn;
      childProcess.spawnSync = originalChildProcess.spawnSync;
      hook.deregister();
      restoreTransport();
      delete (globalThis as Record<PropertyKey, unknown>)[PREVIEW_PROCESS_STATE];
    }
  };

  childProcess.exec = ((command: string, ..._args: unknown[]) => denyChildProcess('exec', command)) as unknown as typeof childProcess.exec;
  childProcess.execFile = ((file: string, ..._args: unknown[]) => denyChildProcess('execFile', file)) as unknown as typeof childProcess.execFile;
  childProcess.execFileSync = ((file: string, ..._args: unknown[]) => denyChildProcess('execFileSync', file)) as unknown as typeof childProcess.execFileSync;
  childProcess.execSync = ((command: string, ..._args: unknown[]) => denyChildProcess('execSync', command)) as unknown as typeof childProcess.execSync;
  childProcess.fork = ((modulePath: string, ..._args: unknown[]) => denyChildProcess('fork', modulePath)) as unknown as typeof childProcess.fork;
  childProcess.spawn = ((command: string, ..._args: unknown[]) => denyChildProcess('spawn', command)) as unknown as typeof childProcess.spawn;
  childProcess.spawnSync = ((command: string, ..._args: unknown[]) => denyChildProcess('spawnSync', command)) as unknown as typeof childProcess.spawnSync;

  globalThis.fetch = installFetchPolicy(config, state, originalFetch);
  (globalThis as Record<PropertyKey, unknown>)[PREVIEW_PROCESS_STATE] = state;
  return state;
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

function assertAllowedModule(specifier: string, parentRef?: string): void {
  const state = getPreviewProcessState() as PreviewModuleState | undefined;
  if (!state?.guardActive) return;
  const denied = FORBIDDEN_IMPORT_SPECIFIERS.get(specifier);
  if (denied) {
    if (isTrustedWorkerParent(parentRef)) return;
    throw new Error(`invoke: preview worker denied raw module import ${denied}`);
  }
}

function isTrustedWorkerParent(parentRef: string | undefined): boolean {
  if (!parentRef) return false;
  const normalized = parentRef.startsWith('file:')
    ? fileURLToPath(parentRef)
    : parentRef;
  return normalized.startsWith(TRUSTED_WORKER_ROOT);
}

function stringifyCommand(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function installFetchPolicy(
  config: LocalPreviewGuardConfig,
  state: PreviewProcessState,
  originalFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = toRequest(input, init);
    const fixture = config.fixtures.find((candidate) =>
      candidate.method.toUpperCase() === request.method && request.url.includes(candidate.match)
    );
    if (fixture) {
      state.recordAction({
        kind: 'http.read',
        status: 'previewed',
        data: {
          method: request.method,
          url: request.url,
          source: fixture.sourcePath ?? 'fixture'
        }
      });
      return new Response(fixture.body, {
        status: 200,
        headers: {
          'content-type': fixture.contentType ?? 'application/json'
        }
      });
    }

    return await fetchLiveWithRedirectGuard(config, state, request, 0, originalFetch);
  }) as typeof globalThis.fetch;
}

async function fetchLiveWithRedirectGuard(
  config: LocalPreviewGuardConfig,
  state: PreviewProcessState,
  request: Request,
  redirects: number,
  originalFetch: typeof globalThis.fetch
): Promise<Response> {
  const method = request.method.toUpperCase();
  const url = request.url;

  if (config.policy.reads !== 'live' || !['GET', 'HEAD'].includes(method)) {
    state.recordAction({
      kind: 'http.read',
      status: 'denied',
      data: { method, url }
    });
    throw new Error(`invoke policy denied ${method} ${url}`);
  }

  if (
    config.policy.allowedHttp.length > 0
    && !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, url))
  ) {
    state.recordAction({
      kind: 'http.read',
      status: 'denied',
      data: { method, url }
    });
    throw new Error(`invoke policy denied undeclared live read ${method} ${url}`);
  }

  state.recordAction({
    kind: 'http.read',
    status: 'previewed',
    data: { method, url, source: 'live', at: state.now().toISOString() }
  });

  const response = await originalFetch(new Request(request, { redirect: 'manual' }));
  if (!isRedirect(response.status)) return response;

  const location = response.headers.get('location');
  if (!location) return response;
  if (redirects >= MAX_REDIRECTS) {
    state.recordAction({
      kind: 'http.read',
      status: 'denied',
      data: { method, url, reason: 'too_many_redirects' }
    });
    throw new Error(`invoke policy denied redirect chain for ${method} ${url}: too many redirects`);
  }

  const redirectedUrl = new URL(location, url).toString();
  if (
    config.policy.allowedHttp.length > 0
    && !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, redirectedUrl))
  ) {
    state.recordAction({
      kind: 'http.read',
      status: 'denied',
      data: { method, url: redirectedUrl, redirectedFrom: url }
    });
    throw new Error(`invoke policy denied redirected live read ${method} ${redirectedUrl}`);
  }

  const redirectedRequest = new Request(redirectedUrl, {
    method: response.status === 303 ? 'GET' : method,
    headers: request.headers,
    redirect: 'manual'
  });
  return await fetchLiveWithRedirectGuard(
    config,
    state,
    redirectedRequest,
    redirects + 1,
    originalFetch
  );
}

function toRequest(input: URL | RequestInfo, init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init);
  if (input instanceof URL) return new Request(input, init);
  return new Request(input, init);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function httpRuleMatches(
  rule: { method: string; urlGlob: string },
  method: string,
  url: string
): boolean {
  if (rule.method.toUpperCase() !== method.toUpperCase()) return false;
  const pattern = rule.urlGlob.includes('*')
    ? new RegExp(`^${rule.urlGlob.split('*').map(escapeRegExp).join('.*')}$`)
    : null;
  return pattern ? pattern.test(url) : url.includes(rule.urlGlob);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
