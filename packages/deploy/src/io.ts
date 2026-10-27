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
    },
    async select(question, options) {
      if (options.length === 0) return '';
      process.stdout.write(`${question}:\n`);
      options.forEach((option, index) => {
        const hint = option.hint ? ` — ${option.hint}` : '';
        process.stdout.write(`  ${index + 1}) ${option.label}${hint}\n`);
      });
      // Default to the first option on empty input; accept an in-range number;
      // re-prompt a purely-numeric out-of-range answer; otherwise treat the
      // answer as a directly-pasted value (escape hatch for ids not listed).
      for (;;) {
        const answer = (await ask(`Enter 1-${options.length} (or paste a value) [1] `)).trim();
        if (answer === '') return options[0]!.value;
        const index = Number.parseInt(answer, 10);
        if (String(index) === answer) {
          if (index >= 1 && index <= options.length) return options[index - 1]!.value;
          process.stderr.write(`! ${answer} is out of range (1-${options.length})\n`);
          continue;
        }
        return answer;
      }
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
