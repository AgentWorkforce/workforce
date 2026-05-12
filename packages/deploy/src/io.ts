import readline from 'node:readline/promises';
import type { DeployIO } from './types.js';

/**
 * Default IO implementation backed by the terminal. Writes status to
 * stdout/stderr and uses node:readline for interactive prompts. Tests
 * supply a deterministic in-memory IO via `DeployOptions.io`.
 */
export function createTerminalIO(): DeployIO {
  // One short-lived readline interface per question. Holding a long-
  // lived interface keeps stdin in raw mode and pins the event loop
  // open, so non-interactive callers (`workforce deploy --no-connect`
  // in CI) see `process.exit(0)` hang or get phantom keystrokes.
  async function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  return {
    info(message: string) {
      process.stdout.write(`${message}\n`);
    },
    warn(message: string) {
      process.stderr.write(`! ${message}\n`);
    },
    error(message: string) {
      process.stderr.write(`x ${message}\n`);
    },
    async prompt(question, opts = {}) {
      const suffix = opts.defaultValue !== undefined ? ` [${opts.defaultValue}]` : '';
      const answer = (await ask(`${question}${suffix} `)).trim();
      return answer.length > 0 ? answer : opts.defaultValue ?? '';
    },
    async confirm(question, opts = {}) {
      const def = opts.defaultValue ?? false;
      const suffix = def ? ' [Y/n]' : ' [y/N]';
      const answer = (await ask(`${question}${suffix} `)).trim().toLowerCase();
      if (answer === '') return def;
      return answer === 'y' || answer === 'yes';
    }
  };
}

/**
 * Buffered IO collected for assertions. Used by tests to verify the
 * orchestrator's message flow without touching the terminal.
 */
export interface BufferedIO extends DeployIO {
  messages: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  /** Queue answers for upcoming prompts; FIFO. */
  scriptAnswers(values: string[]): void;
  scriptConfirmations(values: boolean[]): void;
}

export function createBufferedIO(): BufferedIO {
  const messages: BufferedIO['messages'] = [];
  const answerQueue: string[] = [];
  const confirmQueue: boolean[] = [];
  return {
    messages,
    info(message) {
      messages.push({ level: 'info', message });
    },
    warn(message) {
      messages.push({ level: 'warn', message });
    },
    error(message) {
      messages.push({ level: 'error', message });
    },
    async prompt(_question, opts) {
      return answerQueue.shift() ?? opts?.defaultValue ?? '';
    },
    async confirm(_question, opts) {
      const next = confirmQueue.shift();
      return next ?? opts?.defaultValue ?? false;
    },
    scriptAnswers(values) {
      answerQueue.push(...values);
    },
    scriptConfirmations(values) {
      confirmQueue.push(...values);
    }
  };
}
