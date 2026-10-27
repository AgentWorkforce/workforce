import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NonInteractivePrompt } from '@agentworkforce/persona-kit';

export interface CapturedProcessResult {
  output: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnAndCaptureArgs {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
}

/** Spawn a process and capture its output, optionally delivering one complete
 * prompt through stdin. A failed pipe is folded into the process result so an
 * early child exit cannot become either an unhandled EPIPE or a false success. */
export async function spawnAndCapture(
  args: SpawnAndCaptureArgs
): Promise<CapturedProcessResult> {
  return new Promise((resolve) => {
    const hasStdin = args.stdin !== undefined;
    const child = spawn(args.bin, args.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let processResult: CapturedProcessResult | undefined;
    let stdinSettled = !hasStdin;
    let stdinError: Error | undefined;
    let resolved = false;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };
    const finish = () => {
      if (resolved || !processResult || !stdinSettled) return;
      resolved = true;
      clearTimers();
      if (stdinError) {
        const detail = `failed to deliver prompt via stdin: ${stdinError.message}\n`;
        resolve({
          ...processResult,
          stderr: `${processResult.stderr}${detail}`,
          exitCode: processResult.exitCode === 0 ? 1 : processResult.exitCode
        });
        return;
      }
      resolve(processResult);
    };
    const settleStdin = (err?: Error) => {
      // A writable's end callback can run before a late EPIPE notification.
      // Preserve that error as long as the child result has not been settled.
      if (err && !stdinError) stdinError = err;
      if (stdinSettled) return;
      stdinSettled = true;
      finish();
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    if (hasStdin) {
      const input = child.stdin;
      if (!input) {
        settleStdin(new Error('child stdin pipe was not created'));
      } else {
        input.on('error', (err) => settleStdin(err));
        input.on('close', () => {
          if (!input.writableFinished) {
            settleStdin(new Error('child stdin closed before the prompt was written'));
          }
        });
        input.end(args.stdin, 'utf8', () => settleStdin());
      }
    }

    timeout =
      args.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGTERM');
            forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 1000);
          }, args.timeoutMs)
        : undefined;
    child.on('error', (err) => {
      processResult = { output: stdout, stderr: `${stderr}${err.message}\n`, exitCode: 1 };
      // spawn failures cannot consume stdin; the process error already carries
      // the actionable cause and must not wait on a pipe callback that may not fire.
      stdinSettled = true;
      finish();
    });
    child.on('close', (code, signal) => {
      processResult = {
        output: stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : signal ? signalExitCode(signal) : 1
      };
      finish();
    });
  });
}

export interface SpawnNonInteractiveAndCaptureArgs
  extends Omit<SpawnAndCaptureArgs, 'stdin'> {
  prompt: NonInteractivePrompt;
}

/** Deliver a non-interactive prompt using the harness-specific off-argv mode.
 * Grok's prompt file is private and is removed even when spawning or the child
 * process fails. */
export async function spawnNonInteractiveAndCapture(
  args: SpawnNonInteractiveAndCaptureArgs
): Promise<CapturedProcessResult> {
  const { prompt, ...spawnArgs } = args;
  if (prompt.mode === 'stdin') {
    return spawnAndCapture({ ...spawnArgs, stdin: prompt.contents });
  }

  const promptDir = await mkdtemp(path.join(tmpdir(), 'agentworkforce-prompt-'));
  const promptPath = path.join(promptDir, 'prompt.txt');
  try {
    await writeFile(promptPath, prompt.contents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    return await spawnAndCapture({
      ...spawnArgs,
      args: [...spawnArgs.args, prompt.flag, promptPath]
    });
  } finally {
    await rm(promptDir, { recursive: true, force: true });
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  const code = signal.startsWith('SIG') ? signalCode(signal.slice(3)) : undefined;
  return code ? 128 + code : 1;
}

function signalCode(name: string): number | undefined {
  const signals: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    ILL: 4,
    TRAP: 5,
    ABRT: 6,
    BUS: 7,
    FPE: 8,
    KILL: 9,
    USR1: 10,
    SEGV: 11,
    USR2: 12,
    PIPE: 13,
    ALRM: 14,
    TERM: 15
  };
  return signals[name];
}
