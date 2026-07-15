import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExecuteLocalRunOptions,
  ExecuteLocalRunResult,
  LocalHttpFixture,
  LocalPreviewMemoryEntry,
  LocalPreviewState,
  LocalPreviewGuardConfig,
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

export async function executeLocalRun(
  options: ExecuteLocalRunOptions
): Promise<ExecuteLocalRunResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wf-local-preview-'));
  const controlPath = path.join(tempDir, 'control.json');
  const payloadPath = path.join(tempDir, 'payload.json');
  const resultPath = path.join(tempDir, 'result.json');
  const workerBootstrapPath = fileURLToPath(new URL('./local-preview-bootstrap.js', import.meta.url));
  const workerEntryPath = fileURLToPath(new URL('./local-preview-child.js', import.meta.url));
  const control: LocalPreviewGuardConfig = {
    policy: options.request.policy,
    fixtures: options.httpFixtures ?? [],
    ...(options.now ? { clockNow: options.now().toISOString() } : {})
  };
  const payload: LocalPreviewWorkerPayload = {
    request: options.request,
    bundlePath: options.bundlePath,
    ...(options.inputs ? { inputs: options.inputs } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.replayProvenance ? { replayProvenance: options.replayProvenance } : {})
  };

  try {
    await writeFile(controlPath, JSON.stringify(control), 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');
    const workerExit = await runPreviewWorker({
      workerBootstrapPath,
      workerEntryPath,
      env: buildWorkerEnv(options.inputs ?? {}, {
        WORKFORCE_LOCAL_PREVIEW_CONTROL_PATH: controlPath,
        WORKFORCE_LOCAL_PREVIEW_PAYLOAD_PATH: payloadPath,
        WORKFORCE_LOCAL_PREVIEW_RESULT_PATH: resultPath
      })
    });

    const result = await readWorkerResult(resultPath);
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (workerExit.exitCode !== 0) {
      throw new Error(workerExit.stderr || `invoke worker exited with code ${String(workerExit.exitCode)}`);
    }
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runPreviewWorker(args: {
  workerBootstrapPath: string;
  workerEntryPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--import', args.workerBootstrapPath, args.workerEntryPath],
    {
      cwd: process.cwd(),
      env: args.env,
      stdio: ['ignore', 'ignore', 'pipe']
    }
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  return { exitCode, stderr: stderr.trim() };
}

async function readWorkerResult(resultPath: string): Promise<LocalPreviewWorkerResult> {
  try {
    return JSON.parse(await readFile(resultPath, 'utf8')) as LocalPreviewWorkerResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('invoke worker exited before writing a result');
    }
    throw error;
  }
}

function buildWorkerEnv(
  inputs: Record<string, string>,
  extraEnv: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (WORKER_ENV_KEEP.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(inputs)) {
    env[key] = value;
    env[`WORKFORCE_INPUT_${key}`] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }
  return env;
}
