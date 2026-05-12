import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BundleResult } from '../bundle.js';

export interface DevRunInput {
  bundle: BundleResult;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
}

export interface DevRunHandle {
  pid: number;
  stop(): Promise<void>;
  done: Promise<{ code: number; signal: NodeJS.Signals | null }>;
}

export async function runDev(input: DevRunInput): Promise<DevRunHandle> {
  const child = spawn('node', [input.bundle.runnerPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...input.env }
  });

  const emit = input.onLog ?? ((line: string) => console.log(line));
  const flushStdout = lineBuffer((line) => emit(`[runtime] ${line}`));
  const flushStderr = lineBuffer((line) => emit(`[runtime] ${line}`));

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', flushStdout.write);
  child.stderr.on('data', flushStderr.write);

  let settled = false;
  const stop = () => stopChild(child, () => settled);
  const onSigint = () => {
    void stop();
  };
  const cleanup = () => {
    settled = true;
    flushStdout.end();
    flushStderr.end();
    process.off('SIGINT', onSigint);
  };
  const done = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code: code ?? 0, signal });
    });
  });

  process.on('SIGINT', onSigint);

  return {
    pid: child.pid ?? 0,
    stop,
    done
  };
}

function lineBuffer(onLine: (line: string) => void): {
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
          onLine(line);
        }
        index = pending.indexOf('\n');
      }
    },
    end(): void {
      const line = pending.replace(/\r$/, '');
      pending = '';
      if (line.length > 0) {
        onLine(line);
      }
    }
  };
}

async function stopChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  isSettled: () => boolean
): Promise<void> {
  if (isSettled()) {
    return;
  }

  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (!isSettled()) {
      child.kill('SIGKILL');
    }
  }, 5_000);
  killTimer.unref();

  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  clearTimeout(killTimer);
}
