import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultLlm } from './cloud-llm.js';
import {
  isCredentialLikeValue,
  redactLocalPreviewText
} from './local-preview-redaction.js';
import type {
  ExecuteLocalRunOptions,
  ExecuteLocalRunResult,
  LocalHttpFixture,
  LocalPreviewFetchRequestMessage,
  LocalPreviewFetchResponseMessage,
  LocalPreviewGuardConfig,
  LocalPreviewModelRequestMessage,
  LocalPreviewModelResponseMessage,
  LocalPreviewMemoryEntry,
  LocalPreviewState,
  LocalPreviewWorkerInboundMessage,
  LocalPreviewWorkerInitMessage,
  LocalPreviewWorkerOutboundMessage,
  LocalPreviewWorkerPayload,
  LocalPreviewWorkerResult
} from './local-preview-contract.js';

export type {
  ExecuteLocalRunOptions,
  ExecuteLocalRunResult,
  LocalHttpFixture,
  LocalModelFixture,
  LocalPreviewMemoryEntry,
  LocalPreviewState
} from './local-preview-contract.js';

const WORKER_ENV_KEEP = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_ENV',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'WF_LOCAL_PREVIEW_FETCH_TIMEOUT_MS',
  'WF_LOCAL_PREVIEW_MODEL_TIMEOUT_MS',
  'WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS',
  'WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS',
  'WF_LOCAL_PREVIEW_READY_TIMEOUT_MS'
]);

const SECRET_INPUT_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLOUD_API_ACCESS_TOKEN',
  'CODEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'RELAYFILE_TOKEN',
  'RELAY_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WORKFORCE_AGENT_TOKEN',
  'WORKFORCE_WORKSPACE_TOKEN'
]);

const SECRET_INPUT_SEGMENT = /(^|_)(ACCESS_KEY|API_KEY|AUTH|BEARER|CLIENT_SECRET|COOKIE|CREDENTIAL|CREDENTIALS|OAUTH|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|SESSION|TOKEN|WEBHOOK_SECRET)(_|$)/u;
const STRIP_LIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie'
]);
const MAX_REDIRECTS = 8;
const REDACTED_INPUT_VALUE = '[redacted]';
const WORKER_ENTRY_PATH = fileURLToPath(new URL('./local-preview-child.js', import.meta.url));
const WORKER_RUNTIME_ROOT = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
let spawnPreviewWorkerProcess: typeof spawn = spawn;

export function __setPreviewWorkerSpawnForTest(
  value: typeof spawn | undefined
): void {
  spawnPreviewWorkerProcess = value ?? spawn;
}

export async function executeLocalRun(
  options: ExecuteLocalRunOptions
): Promise<ExecuteLocalRunResult> {
  assertPermissionBoundarySupport();

  const sanitizedInputs = sanitizeWorkerInputs(options.inputs ?? {});
  const control: LocalPreviewGuardConfig = {
    policy: options.request.policy,
    fixtures: options.httpFixtures ?? [],
    ...(options.state?.transport ? { transportState: options.state.transport } : {}),
    ...(options.now ? { clockNow: options.now().toISOString() } : {})
  };
  const payload: LocalPreviewWorkerPayload = {
    request: {
      ...options.request,
      inputs: { ...sanitizedInputs.ctxInputs }
    },
    bundlePath: options.bundlePath,
    inputs: sanitizedInputs.ctxInputs,
    ...(options.state ? { state: options.state } : {}),
    ...(options.replayProvenance ? { replayProvenance: options.replayProvenance } : {}),
    ...(options.sourceFidelity ? { sourceFidelity: options.sourceFidelity } : {})
  };
  const liveModelAdapter = options.modelAdapter ?? createDefaultLlm({
    persona: options.request.agent.persona,
    env: process.env,
    log: () => undefined
  });
  const modelFixtures = options.modelFixtures ?? [];
  let modelFixtureCursor = options.state?.model?.fixtureCursor ?? 0;

  const stagedBundle = await stageWorkerBundle(options.bundlePath);
  try {
    payload.bundlePath = stagedBundle.bundlePath;
    const workerResult = await runPreviewWorker({
      bundlePath: stagedBundle.bundlePath,
      extraReadRoots: stagedBundle.readRoots,
      env: buildWorkerEnv(sanitizedInputs.envInputs),
      init: {
        type: 'init',
        config: control,
        payload
      },
      onModelRequest: async (request) => {
        const sourceFidelity = payload.sourceFidelity?.model
          ?? (options.request.policy.model === 'live'
            ? 'current'
            : options.request.policy.model === 'fixture'
              ? 'fixture'
              : 'simulated');
        if (options.request.policy.model === 'fixture') {
          const fixture = modelFixtures[modelFixtureCursor];
          if (!fixture) {
            return {
              type: 'model-response',
              requestId: request.requestId,
              ok: false,
              action: {
                kind: 'model.complete',
                status: 'denied',
                data: {
                  mode: 'fixture',
                  promptChars: request.prompt.length,
                  source: 'unavailable',
                  fixtureIndex: modelFixtureCursor + 1
                },
                extensions: {
                  sourceFidelity: 'unavailable'
                }
              },
              error: modelFixtures.length === 0
                ? 'invoke: model fixture mode requires explicit case model fixtures'
                : `invoke: model fixture ${modelFixtureCursor + 1} requested but only ${modelFixtures.length} fixture(s) are available`
            };
          }
          modelFixtureCursor += 1;
          return {
            type: 'model-response',
            requestId: request.requestId,
            ok: true,
            action: {
              kind: 'model.complete',
              status: 'previewed',
              data: {
                mode: 'fixture',
                promptChars: request.prompt.length,
                outputChars: fixture.output.length,
                source: 'fixture',
                fixtureIndex: modelFixtureCursor,
                ...(fixture.sourcePath ? { sourceDetail: fixture.sourcePath } : {})
              },
              extensions: {
                sourceFidelity: sourceFidelity
              }
            },
            output: fixture.output
          };
        }

        if (options.request.policy.model !== 'live') {
          return {
            type: 'model-response',
            requestId: request.requestId,
            ok: false,
            action: {
              kind: 'model.complete',
              status: 'denied',
              data: {
                mode: options.request.policy.model,
                promptChars: request.prompt.length,
                source: 'unavailable'
              },
              extensions: {
                sourceFidelity: 'unavailable'
              }
            },
            error: `invoke: preview worker unexpectedly requested parent model bridge in ${options.request.policy.model} mode`
          };
        }

        if (!liveModelAdapter) {
          return {
            type: 'model-response',
            requestId: request.requestId,
            ok: false,
            action: {
              kind: 'model.complete',
              status: 'denied',
              data: {
                mode: 'live',
                promptChars: request.prompt.length,
                source: 'unavailable'
              },
              extensions: {
                sourceFidelity: 'unavailable'
              }
            },
            error: 'invoke: live model mode requires a parent-side model adapter with supported current credentials'
          };
        }

        try {
          const output = await promiseWithTimeout(
            liveModelAdapter.complete(request.prompt, request.maxTokens ? { maxTokens: request.maxTokens } : undefined),
            localPreviewModelTimeoutMs(),
            'invoke: parent model adapter timed out'
          );
          return {
            type: 'model-response',
            requestId: request.requestId,
            ok: true,
            action: {
              kind: 'model.complete',
              status: 'previewed',
              data: {
                mode: 'live',
                promptChars: request.prompt.length,
                outputChars: output.length,
                source: 'current'
              },
              extensions: {
                sourceFidelity: sourceFidelity
              }
            },
            output
          };
        } catch (error) {
          const message = redactLocalPreviewText(error instanceof Error ? error.message : String(error));
          return {
            type: 'model-response',
            requestId: request.requestId,
            ok: false,
            action: {
              kind: 'model.complete',
              status: 'denied',
              data: {
                mode: 'live',
                promptChars: request.prompt.length,
                source: 'current'
              },
              extensions: {
                sourceFidelity: 'current'
              }
            },
            error: `invoke: parent model adapter failed: ${message}`
          };
        }
      }
    });

    if (!workerResult.ok) {
      throw new Error(workerResult.stack ? `${workerResult.error}\n${workerResult.stack}` : workerResult.error);
    }
    workerResult.state = {
      ...workerResult.state,
      model: { fixtureCursor: modelFixtureCursor }
    };
    return workerResult;
  } finally {
    if (process.env.WF_KEEP_LOCAL_PREVIEW_STAGE !== '1') {
      await rm(stagedBundle.dir, { recursive: true, force: true });
    }
  }
}

async function runPreviewWorker(args: {
  bundlePath: string;
  extraReadRoots: readonly string[];
  env: NodeJS.ProcessEnv;
  init: LocalPreviewWorkerInitMessage;
  onModelRequest: (request: LocalPreviewModelRequestMessage) => Promise<LocalPreviewModelResponseMessage>;
}): Promise<LocalPreviewWorkerResult> {
  const permissionArgs = await buildWorkerPermissionArgs(args.bundlePath, args.extraReadRoots);
  const child = spawnPreviewWorkerProcess(
    process.execPath,
    [...permissionArgs, WORKER_ENTRY_PATH],
    {
      cwd: process.cwd(),
      env: args.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  );

  let stderr = '';
  let result: LocalPreviewWorkerResult | undefined;
  let ready = false;
  const pendingResponses = new Map<Promise<void>, AbortController>();

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  child.on('message', (message: LocalPreviewWorkerOutboundMessage) => {
    if (message?.type === 'ready') {
      ready = true;
      return;
    }
    if (message?.type === 'result') {
      result = message.result;
      return;
    }
    if (message?.type === 'model') {
      const work = respondToModel(child, message, args.onModelRequest)
        .finally(() => pendingResponses.delete(work));
      pendingResponses.set(work, new AbortController());
      return;
    }
    if (message?.type !== 'fetch') return;
    const controller = new AbortController();
    const work = respondToFetch(child, args.init.config, message, controller)
      .finally(() => pendingResponses.delete(work));
    pendingResponses.set(work, controller);
  });

  const failAndStop = async (error: unknown): Promise<never> => {
    abortPendingResponses(pendingResponses);
    await stopChildProcess(child);
    throw error;
  };

  try {
    await waitForWorkerReady(child, () => ready, localPreviewReadyTimeoutMs(), () => stderr);
    await sendToChild(child, args.init);
  } catch (error) {
    return await failAndStop(error);
  }

  let exitCode: number | null;
  try {
    exitCode = await waitForChildClose(child, localPreviewOverallTimeoutMs());
  } catch (error) {
    return await failAndStop(error);
  }

  abortPendingResponses(pendingResponses);
  await Promise.allSettled([...pendingResponses.keys()]);

  if (!result) {
    throw new Error(stderr.trim() || `invoke worker exited with code ${String(exitCode)}`);
  }
  if (exitCode !== 0 && result.ok) {
    throw new Error(stderr.trim() || `invoke worker exited with code ${String(exitCode)}`);
  }
  return result;
}

async function respondToFetch(
  child: import('node:child_process').ChildProcess,
  config: LocalPreviewGuardConfig,
  request: LocalPreviewFetchRequestMessage,
  controller: AbortController
): Promise<void> {
  const response = await resolveParentFetch(config, request, controller);
  await sendToChild(child, response);
}

async function respondToModel(
  child: import('node:child_process').ChildProcess,
  request: LocalPreviewModelRequestMessage,
  onModelRequest: (request: LocalPreviewModelRequestMessage) => Promise<LocalPreviewModelResponseMessage>
): Promise<void> {
  const response = await onModelRequest(request);
  await sendToChild(child, response);
}

async function resolveParentFetch(
  config: LocalPreviewGuardConfig,
  request: LocalPreviewFetchRequestMessage,
  controller: AbortController
): Promise<LocalPreviewFetchResponseMessage> {
  const method = request.method.toUpperCase();
  const fixture = config.fixtures.find((candidate) =>
    candidate.method.toUpperCase() === method && request.url.includes(candidate.match)
  );
  if (fixture) {
    return {
      type: 'fetch-response',
      requestId: request.requestId,
      ok: true,
      action: {
        kind: 'http.read',
        status: 'previewed',
        data: {
          method,
          url: request.url,
          source: 'fixture',
          ...(fixture.sourcePath ? { sourceDetail: fixture.sourcePath } : {})
        },
        extensions: {
          sourceFidelity: 'fixture'
        }
      },
      response: {
        status: 200,
        headers: [['content-type', fixture.contentType ?? 'application/json']],
        bodyBase64: Buffer.from(fixture.body, 'utf8').toString('base64')
      }
    };
  }

  try {
    return await resolveLiveParentFetch(config, request, 0, controller);
  } catch {
    if (controller.signal.aborted) {
      return parentFetchErrorResponse(
        request,
        {
          method,
          url: request.url,
          reason: 'parent_fetch_timeout'
        },
        `invoke parent fetch timeout after ${localPreviewFetchTimeoutMs()}ms for ${method} ${request.url}`
      );
    }
    return parentFetchErrorResponse(
      request,
      {
        method,
        url: request.url,
        reason: 'parent_fetch_failed'
      },
      `invoke parent fetch failed for ${method} ${request.url}: network error`
    );
  }
}

async function resolveLiveParentFetch(
  config: LocalPreviewGuardConfig,
  request: LocalPreviewFetchRequestMessage,
  redirects: number,
  controller: AbortController
): Promise<LocalPreviewFetchResponseMessage> {
  const method = request.method.toUpperCase();
  const url = request.url;

  if (config.policy.reads !== 'live' || !['GET', 'HEAD'].includes(method)) {
    return deniedFetchResponse(request, {
      method,
      url
    }, `invoke policy denied ${method} ${url}`);
  }

  if (
    !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, url))
  ) {
    return deniedFetchResponse(request, {
      method,
      url
    }, `invoke policy denied undeclared live read ${method} ${url}`);
  }

  const timeout = setTimeout(() => controller.abort(), localPreviewFetchTimeoutMs());
  let response: Response;
  const { headers, strippedHeaders } = sanitizeLiveRequestHeaders(request.headers);
  try {
    response = await fetch(new Request(url, {
      method,
      headers,
      ...(request.bodyBase64 ? { body: Buffer.from(request.bodyBase64, 'base64') } : {}),
      redirect: 'manual',
      signal: controller.signal
    }));
  } finally {
    clearTimeout(timeout);
  }

  if (!isRedirect(response.status)) {
    return {
      type: 'fetch-response',
      requestId: request.requestId,
      ok: true,
      action: {
        kind: 'http.read',
        status: 'previewed',
        data: {
          method,
          url,
          source: 'current',
          ...(strippedHeaders.length > 0 ? { strippedHeaders } : {})
        },
        extensions: {
          sourceFidelity: 'current'
        }
      },
      response: {
        status: response.status,
        headers: [...response.headers.entries()],
        bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64')
      }
    };
  }

  const location = response.headers.get('location');
  if (!location) {
    return {
      type: 'fetch-response',
      requestId: request.requestId,
      ok: true,
      action: {
        kind: 'http.read',
        status: 'previewed',
        data: {
          method,
          url,
          source: 'current',
          ...(strippedHeaders.length > 0 ? { strippedHeaders } : {})
        },
        extensions: {
          sourceFidelity: 'current'
        }
      },
      response: {
        status: response.status,
        headers: [...response.headers.entries()],
        bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64')
      }
    };
  }

  if (redirects >= MAX_REDIRECTS) {
    return deniedFetchResponse(request, {
      method,
      url,
      reason: 'too_many_redirects'
    }, `invoke policy denied redirect chain for ${method} ${url}: too many redirects`);
  }

  const redirectedUrl = new URL(location, url).toString();
  if (
    !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, redirectedUrl))
  ) {
    return deniedFetchResponse(request, {
      method,
      url: redirectedUrl,
      redirectedFrom: url
    }, `invoke policy denied redirected live read ${method} ${redirectedUrl}`);
  }

  return await resolveLiveParentFetch(config, {
    ...request,
    method: response.status === 303 ? 'GET' : method,
    url: redirectedUrl,
    ...(response.status === 303 ? { bodyBase64: undefined } : {})
  }, redirects + 1, controller);
}

function deniedFetchResponse(
  request: LocalPreviewFetchRequestMessage,
  data: Record<string, unknown>,
  error: string
): LocalPreviewFetchResponseMessage {
  return {
    type: 'fetch-response',
    requestId: request.requestId,
    ok: false,
    action: {
      kind: 'http.read',
      status: 'denied',
      data
    },
    error
  };
}

function parentFetchErrorResponse(
  request: LocalPreviewFetchRequestMessage,
  data: Record<string, unknown>,
  error: string
): LocalPreviewFetchResponseMessage {
  return {
    type: 'fetch-response',
    requestId: request.requestId,
    ok: false,
    action: {
      kind: 'http.read',
      status: 'denied',
      data
    },
    error
  };
}

function buildWorkerEnv(inputs: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (WORKER_ENV_KEEP.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(inputs)) {
    const safeValue = redactLocalPreviewText(value);
    env[key] = safeValue;
    env[`WORKFORCE_INPUT_${key}`] = safeValue;
  }
  return env;
}

async function buildWorkerPermissionArgs(bundlePath: string, extraReadRoots: readonly string[]): Promise<string[]> {
  const bundleDirPath = path.dirname(bundlePath);
  const bundleDir = await realpath(path.dirname(bundlePath));
  const bundleFile = await realpath(bundlePath);
  const runtimeRoot = await realpath(WORKER_RUNTIME_ROOT);
  const runtimePackageRoot = await resolveRuntimePackageRoot();
  const readRoots = uniquePaths([
    runtimeRoot,
    runtimePackageRoot,
    ...collectRuntimeDependencyRoots(runtimePackageRoot),
    ...extraReadRoots,
    bundleDirPath,
    bundlePath,
    bundleDir,
    bundleFile
  ]);
  return [
    '--permission',
    ...readRoots.map((entry) => `--allow-fs-read=${entry}`)
  ];
}

async function stageWorkerBundle(bundlePath: string): Promise<{
  dir: string;
  bundlePath: string;
  readRoots: string[];
}> {
  const stagingRoot = path.join(resolveLocalPreviewWorkspaceRoot(), '.workforce');
  await mkdir(stagingRoot, { recursive: true });
  const dir = await mkdtemp(path.join(stagingRoot, 'local-preview-worker-'));
  const stagedBundlePath = path.join(dir, path.basename(bundlePath));
  await copyFile(bundlePath, stagedBundlePath);
  const runtimePackageRoot = await resolveRuntimePackageRoot();
  const runtimeNodeModulesDir = path.join(dir, 'node_modules', '@agentworkforce');
  await mkdir(runtimeNodeModulesDir, { recursive: true });
  await symlink(runtimePackageRoot, path.join(runtimeNodeModulesDir, 'runtime'));
  return {
    dir,
    bundlePath: stagedBundlePath,
    readRoots: uniquePaths([
      path.dirname(bundlePath),
      bundlePath,
      runtimePackageRoot
    ])
  };
}

function sanitizeWorkerInputs(inputs: Record<string, string>): {
  ctxInputs: Record<string, string>;
  envInputs: Record<string, string>;
} {
  const ctxInputs: Record<string, string> = {};
  const envInputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (isSecretInputKey(key) || isCredentialLikeValue(value)) {
      ctxInputs[key] = REDACTED_INPUT_VALUE;
      continue;
    }
    ctxInputs[key] = value;
    envInputs[key] = value;
  }
  return { ctxInputs, envInputs };
}

function isSecretInputKey(key: string): boolean {
  const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  return SECRET_INPUT_NAMES.has(normalized) || SECRET_INPUT_SEGMENT.test(normalized);
}

function assertPermissionBoundarySupport(): void {
  const detectedVersion = process.versions.node;
  if (
    compareNodeVersions(detectedVersion, '26.3.1') < 0
    || !process.allowedNodeEnvironmentFlags.has('--permission')
    || !process.allowedNodeEnvironmentFlags.has('--allow-fs-read')
    || !process.allowedNodeEnvironmentFlags.has('--allow-net')
  ) {
    throw new Error(
      `invoke: local preview requires supported patched Node >=26.3.1 with --permission, --allow-fs-read, and --allow-net support; detected ${detectedVersion}`
    );
  }
}

function compareNodeVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part));
  const b = right.split('.').map((part) => Number(part));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function resolveLocalPreviewWorkspaceRoot(): string {
  return path.resolve(process.cwd());
}

async function resolveRuntimePackageRoot(): Promise<string> {
  return await realpath(path.dirname(require.resolve('@agentworkforce/runtime/package.json')));
}

function collectRuntimeDependencyRoots(runtimePackageRoot: string): string[] {
  const roots = [path.join(runtimePackageRoot, 'node_modules')];
  let cursor = path.resolve(runtimePackageRoot);
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    const base = path.basename(parent);
    if (base === 'node_modules') {
      roots.push(parent);
    } else if (base === 'packages') {
      roots.push(parent, path.join(path.dirname(parent), 'node_modules'));
    }
    cursor = parent;
  }
  return roots;
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
  return pattern ? pattern.test(url) : url === rule.urlGlob;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function sanitizeLiveRequestHeaders(
  entries: ReadonlyArray<[string, string]>
): { headers: Headers; strippedHeaders: string[] } {
  const headers = new Headers();
  const stripped = new Set<string>();
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (
      STRIP_LIVE_REQUEST_HEADERS.has(normalized) ||
      (normalized.startsWith('x-') && (isCredentialLikeHeaderName(normalized) || isCredentialLikeValue(value)))
    ) {
      stripped.add(normalized);
      continue;
    }
    headers.append(name, value);
  }
  return { headers, strippedHeaders: [...stripped].sort() };
}

function isCredentialLikeHeaderName(name: string): boolean {
  return /(?:access|api|auth|bearer|cookie|credential|key|oauth|proxy|secret|session|token)/u.test(name);
}

function sendToChild(
  child: import('node:child_process').ChildProcess,
  message: LocalPreviewWorkerInboundMessage | LocalPreviewWorkerOutboundMessage
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error('invoke worker IPC channel closed'));
      return;
    }
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForWorkerReady(
  child: import('node:child_process').ChildProcess,
  isReady: () => boolean,
  timeoutMs: number,
  getStderr: () => string
): Promise<void> {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!isReady()) return;
      cleanup();
      resolve();
    }, 10);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(withWorkerStderr(
        `invoke worker timed out waiting for readiness after ${timeoutMs}ms`,
        getStderr()
      )));
    }, timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(withWorkerStderr(error.message, getStderr())));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(withWorkerStderr('invoke worker exited before signaling readiness', getStderr())));
    };
    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.on('error', onError);
    child.on('close', onClose);
  });
}

function withWorkerStderr(message: string, stderr: string): string {
  const trimmed = redactLocalPreviewText(stderr).trim();
  return trimmed ? `${message}\nworker stderr:\n${trimmed}` : message;
}

function waitForChildClose(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`invoke worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.once('error', onError);
    child.once('close', onClose);
  });
}

export async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      if (forceKill) clearTimeout(forceKill);
      if (hardStop) clearTimeout(hardStop);
      child.off('close', onClose);
    };
    forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      hardStop = setTimeout(() => {
        cleanup();
        resolve();
      }, localPreviewKillSettleTimeoutMs());
    }, localPreviewForceKillTimeoutMs());
    child.once('close', onClose);
    child.kill('SIGTERM');
  });
}

function abortPendingResponses(pendingResponses: ReadonlyMap<Promise<void>, AbortController>): void {
  for (const controller of pendingResponses.values()) {
    controller.abort();
  }
}

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function localPreviewReadyTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_READY_TIMEOUT_MS', 5_000);
}

function localPreviewOverallTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS', 30_000);
}

function localPreviewFetchTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_FETCH_TIMEOUT_MS', 10_000);
}

function localPreviewModelTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_MODEL_TIMEOUT_MS', 30_000);
}

function localPreviewForceKillTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS', 1_000);
}

function localPreviewKillSettleTimeoutMs(): number {
  return readTimeoutEnv('WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS', 1_000);
}

async function promiseWithTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    value.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
