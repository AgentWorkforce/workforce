import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExecuteLocalRunOptions,
  ExecuteLocalRunResult,
  LocalHttpFixture,
  LocalPreviewFetchRequestMessage,
  LocalPreviewFetchResponseMessage,
  LocalPreviewGuardConfig,
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
  'USER'
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
const MAX_REDIRECTS = 8;
const REDACTED_INPUT_VALUE = '[redacted]';
const WORKER_ENTRY_PATH = fileURLToPath(new URL('./local-preview-child.js', import.meta.url));
const WORKER_RUNTIME_ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = path.resolve(WORKER_RUNTIME_ROOT, '..', '..', '..');
const require = createRequire(import.meta.url);

export async function executeLocalRun(
  options: ExecuteLocalRunOptions
): Promise<ExecuteLocalRunResult> {
  assertPermissionBoundarySupport();

  const sanitizedInputs = sanitizeWorkerInputs(options.inputs ?? {});
  const control: LocalPreviewGuardConfig = {
    policy: options.request.policy,
    fixtures: options.httpFixtures ?? [],
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
    ...(options.replayProvenance ? { replayProvenance: options.replayProvenance } : {})
  };

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
      }
    });

    if (!workerResult.ok) {
      throw new Error(workerResult.stack ? `${workerResult.error}\n${workerResult.stack}` : workerResult.error);
    }
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
}): Promise<LocalPreviewWorkerResult> {
  const permissionArgs = await buildWorkerPermissionArgs(args.bundlePath, args.extraReadRoots);
  const child = spawn(
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
  const pendingResponses = new Set<Promise<void>>();

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
    if (message?.type !== 'fetch') return;
    const work = respondToFetch(child, args.init.config, message)
      .finally(() => pendingResponses.delete(work));
    pendingResponses.add(work);
  });

  await waitForWorkerReady(child, () => ready);
  await sendToChild(child, args.init);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await Promise.all(pendingResponses);

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
  request: LocalPreviewFetchRequestMessage
): Promise<void> {
  const response = await resolveParentFetch(config, request);
  await sendToChild(child, response);
}

async function resolveParentFetch(
  config: LocalPreviewGuardConfig,
  request: LocalPreviewFetchRequestMessage
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
          source: fixture.sourcePath ?? 'fixture'
        }
      },
      response: {
        status: 200,
        headers: [['content-type', fixture.contentType ?? 'application/json']],
        bodyBase64: Buffer.from(fixture.body, 'utf8').toString('base64')
      }
    };
  }

  return await resolveLiveParentFetch(config, request, 0);
}

async function resolveLiveParentFetch(
  config: LocalPreviewGuardConfig,
  request: LocalPreviewFetchRequestMessage,
  redirects: number
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
    config.policy.allowedHttp.length > 0
    && !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, url))
  ) {
    return deniedFetchResponse(request, {
      method,
      url
    }, `invoke policy denied undeclared live read ${method} ${url}`);
  }

  const response = await fetch(new Request(url, {
    method,
    headers: new Headers(request.headers),
    ...(request.bodyBase64 ? { body: Buffer.from(request.bodyBase64, 'base64') } : {}),
    redirect: 'manual'
  }));
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
          source: 'live'
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
          source: 'live'
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
    config.policy.allowedHttp.length > 0
    && !config.policy.allowedHttp.some((rule) => httpRuleMatches(rule, method, redirectedUrl))
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
  }, redirects + 1);
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

function buildWorkerEnv(inputs: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (WORKER_ENV_KEEP.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(inputs)) {
    env[key] = value;
    env[`WORKFORCE_INPUT_${key}`] = value;
  }
  return env;
}

async function buildWorkerPermissionArgs(bundlePath: string, extraReadRoots: readonly string[]): Promise<string[]> {
  const bundleDirPath = path.dirname(bundlePath);
  const bundleDir = await realpath(path.dirname(bundlePath));
  const bundleFile = await realpath(bundlePath);
  const runtimeRoot = await realpath(WORKER_RUNTIME_ROOT);
  const readRoots = uniquePaths([
    runtimeRoot,
    path.join(WORKSPACE_ROOT, 'node_modules'),
    path.join(WORKSPACE_ROOT, 'packages'),
    path.join(WORKSPACE_ROOT, '.workforce'),
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
  const stagingRoot = path.join(WORKSPACE_ROOT, '.workforce');
  await mkdir(stagingRoot, { recursive: true });
  const dir = await mkdtemp(path.join(stagingRoot, 'local-preview-worker-'));
  const stagedBundlePath = path.join(dir, path.basename(bundlePath));
  await copyFile(bundlePath, stagedBundlePath);
  const originalBundleDir = path.dirname(bundlePath);
  const runtimePackageJson = require.resolve('@agentworkforce/runtime/package.json', {
    paths: [originalBundleDir, WORKSPACE_ROOT]
  });
  const runtimePackageRoot = path.dirname(runtimePackageJson);
  const runtimeNodeModulesDir = path.join(dir, 'node_modules', '@agentworkforce');
  await mkdir(runtimeNodeModulesDir, { recursive: true });
  await symlink(runtimePackageRoot, path.join(runtimeNodeModulesDir, 'runtime'));
  return {
    dir,
    bundlePath: stagedBundlePath,
    readRoots: uniquePaths([
      originalBundleDir,
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
    if (isSecretInputKey(key)) {
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
  if (
    !process.allowedNodeEnvironmentFlags.has('--permission')
    || !process.allowedNodeEnvironmentFlags.has('--allow-fs-read')
  ) {
    throw new Error(
      'invoke: local preview requires a Node runtime with --permission and --allow-fs-read support; refusing to run without an isolated worker boundary'
    );
  }
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
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
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
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
  isReady: () => boolean
): Promise<void> {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (!isReady()) return;
      cleanup();
      resolve();
    }, 10);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('invoke worker exited before signaling readiness'));
    };
    const cleanup = () => {
      clearInterval(interval);
      child.off('error', onError);
      child.off('close', onClose);
    };
    child.on('error', onError);
    child.on('close', onClose);
  });
}
