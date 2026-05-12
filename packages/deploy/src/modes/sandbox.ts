import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Daytona } from '@daytonaio/sdk';
import type { BundleResult } from '../bundle.js';
import type { SandboxConfig } from '../types.js';

export interface SandboxRunInput {
  bundle: BundleResult;
  sandboxConfig: SandboxConfig | true;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
  daytona: { apiKey: string; jwtToken?: string; organizationId?: string };
}

export interface SandboxRunHandle {
  sandboxId: string;
  stop(): Promise<void>;
  done: Promise<{ code: number }>;
}

interface DaytonaLike {
  create(params: { language: 'typescript'; envVars?: Record<string, string> }): Promise<SandboxLike>;
  delete(sandbox: SandboxLike): Promise<void>;
}

interface SandboxLike {
  id: string;
  fs: {
    uploadFiles(files: Array<{ source: string; destination: string }>): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number
    ): Promise<{ exitCode?: number; result?: string }>;
    createSession?: (sessionId: string) => Promise<void>;
    executeSessionCommand?: (
      sessionId: string,
      req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number
    ) => Promise<{ cmdId?: string; exitCode?: number; output?: string; stdout?: string; stderr?: string }>;
    getSessionCommandLogs?: (
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void
    ) => Promise<void>;
    getSessionCommand?: (
      sessionId: string,
      commandId: string
    ) => Promise<{ exitCode?: number | null | undefined }>;
  };
}

type DaytonaFactory = (config: {
  apiKey: string;
  jwtToken?: string;
  organizationId?: string;
}) => DaytonaLike;

let daytonaFactory: DaytonaFactory = (config) => new Daytona(config) as unknown as DaytonaLike;

export function setDaytonaFactoryForTest(factory: DaytonaFactory): () => void {
  const previous = daytonaFactory;
  daytonaFactory = factory;
  return () => {
    daytonaFactory = previous;
  };
}

const remoteProjectDir = '/home/user/project';

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunHandle> {
  const daytona = daytonaFactory(input.daytona);
  const sandbox = await daytona.create({ language: 'typescript', envVars: input.env });

  try {
    await uploadBundle(input.bundle, sandbox);
  } catch (error) {
    await daytona.delete(sandbox);
    throw error;
  }

  const emit = input.onLog ?? ((line: string) => console.log(line));
  const timeoutSeconds =
    input.sandboxConfig === true ? 1_800 : input.sandboxConfig.timeoutSeconds ?? 1_800;

  const done = runCommand(sandbox, {
    env: input.env,
    onLog: (line) => emit(`[runtime] ${line}`),
    timeoutSeconds
  });

  return {
    sandboxId: sandbox.id,
    stop: () => daytona.delete(sandbox),
    done
  };
}

async function uploadBundle(bundle: BundleResult, sandbox: SandboxLike): Promise<void> {
  const bundleDir = dirname(bundle.runnerPath);
  const files = await collectFiles(bundleDir);
  await sandbox.fs.uploadFiles(
    files.map((source) => ({
      source,
      destination: `${remoteProjectDir}/${relative(bundleDir, source).replaceAll('\\', '/')}`
    }))
  );
}

async function runCommand(
  sandbox: SandboxLike,
  opts: { env?: Record<string, string>; onLog: (line: string) => void; timeoutSeconds: number }
): Promise<{ code: number }> {
  const processApi = sandbox.process;
  const sessionId = `workforce-${randomUUID()}`;

  if (
    processApi.createSession &&
    processApi.executeSessionCommand &&
    processApi.getSessionCommandLogs &&
    processApi.getSessionCommand
  ) {
    let sessionCommandStarted = false;
    try {
      await processApi.createSession(sessionId);
      const response = await processApi.executeSessionCommand(
        sessionId,
        {
          command: `cd ${remoteProjectDir} && node runner.mjs`,
          runAsync: true,
          suppressInputEcho: true
        },
        opts.timeoutSeconds
      );
      sessionCommandStarted = true;

      if (!response.cmdId) {
        return emitFinalResult(response, opts.onLog);
      }

      const stdoutBuffer = lineBuffer(opts.onLog);
      const stderrBuffer = lineBuffer(opts.onLog);
      await processApi.getSessionCommandLogs(
        sessionId,
        response.cmdId,
        stdoutBuffer.write,
        stderrBuffer.write
      );
      stdoutBuffer.end();
      stderrBuffer.end();
      const command = await processApi.getSessionCommand(sessionId, response.cmdId);
      return { code: command.exitCode ?? 0 };
    } catch (error) {
      if (sessionCommandStarted) {
        throw error;
      }
      // TODO(human): Daytona SDK streaming behavior is version-sensitive; keep
      // executeCommand as the stable fallback until the cloud runner wrapper
      // exposes a published streaming contract.
    }
  }

  // TODO(human): replace final-result fallback with SDK streaming once the
  // deploy package can depend on the extracted Daytona runner surface.
  const result = await processApi.executeCommand(
    'node runner.mjs',
    remoteProjectDir,
    opts.env,
    opts.timeoutSeconds
  );
  emitBuffered(result.result ?? '', opts.onLog);
  return { code: result.exitCode ?? 0 };
}

function emitFinalResult(
  response: { exitCode?: number; output?: string; stdout?: string; stderr?: string },
  onLog: (line: string) => void
): { code: number } {
  emitBuffered(response.output ?? response.stdout ?? '', onLog);
  emitBuffered(response.stderr ?? '', onLog);
  return { code: response.exitCode ?? 0 };
}

function emitBuffered(chunk: string, onLog: (line: string) => void): void {
  const buffer = lineBuffer(onLog);
  buffer.write(chunk);
  buffer.end();
}

function lineBuffer(onLog: (line: string) => void): {
  write(chunk: string): void;
  end(): void;
} {
  let pending = '';

  return {
    write(chunk: string): void {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line.length > 0) {
          onLog(line);
        }
        index = pending.indexOf('\n');
      }
    },
    end(): void {
      const line = pending.replace(/\r$/, '');
      pending = '';
      if (line.length > 0) {
        onLog(line);
      }
    }
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile() && (await stat(path)).isFile()) {
      files.push(path);
    }
  }

  return files;
}
