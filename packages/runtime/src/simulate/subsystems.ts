import type {
  FilesContext,
  HarnessRunArgs,
  HarnessRunResult,
  LlmContext,
  MemoryContext,
  MemoryItem,
  SandboxContext,
  ScheduleContext,
  WorkflowContext,
  WorkforceCtx
} from '../types.js';
import type { CapturedLogLine, RecordedSideEffect } from './types.js';

/**
 * Mutable sink the orchestrator swaps per envelope so side effects and
 * logs attribute to the run that made them. Handlers run sequentially
 * (the runner's for-await contract), so a single swappable sink is safe.
 */
export interface SimulationSink {
  sideEffects: RecordedSideEffect[];
  logs: CapturedLogLine[];
}

export interface SimulationSubsystems {
  sandbox: SandboxContext;
  files: FilesContext;
  llm: LlmContext;
  memory: MemoryContext;
  workflow: WorkflowContext;
  schedule: ScheduleContext;
  log: WorkforceCtx['log'];
  harnessRunner: (args: HarnessRunArgs) => Promise<HarnessRunResult>;
  /** Point subsequent recordings at a new sink (one per envelope). */
  useSink(sink: SimulationSink): void;
  /** Read-only view of the simulated VFS (seeded + handler-written files). */
  vfsSnapshot(): Record<string, string>;
}

const SIMULATED = '[simulated — not executed]';

/**
 * Build recording, no-side-effect implementations of every ctx channel a
 * handler can reach. Nothing leaves the process: HTTP-backed subsystems
 * (memory, workflow, schedule, llm), the harness, and the sandbox shell
 * all return inert simulated results and record the call. File writes go
 * to an in-memory map shared across the simulation so a handler that
 * writes in one event can read it back in the next.
 */
export function createSimulationSubsystems(options?: {
  files?: Record<string, string>;
  now?: () => Date;
}): SimulationSubsystems {
  const now = options?.now ?? (() => new Date());
  const vfs = new Map<string, string>(Object.entries(options?.files ?? {}));
  let sink: SimulationSink = { sideEffects: [], logs: [] };

  let memorySeq = 0;
  let workflowSeq = 0;

  function record(
    kind: RecordedSideEffect['kind'],
    args: Record<string, unknown>,
    simulatedResult?: unknown
  ): void {
    sink.sideEffects.push({
      kind,
      at: now().toISOString(),
      args,
      ...(simulatedResult !== undefined ? { simulatedResult } : {})
    });
  }

  function readPath(kind: 'sandbox.readFile' | 'files.read', path: string): string {
    const contents = vfs.get(path);
    if (contents === undefined) {
      record(kind, { path }, { error: 'path not seeded' });
      throw new Error(
        `simulation: read of path "${path}" that was never seeded or written. ` +
          'Seed it via the simulation `files` option (e.g. provider VFS data the handler expects).'
      );
    }
    record(kind, { path }, { bytes: contents.length });
    return contents;
  }

  const sandbox: SandboxContext = {
    cwd: '/simulated',
    async exec(cmd, opts) {
      const result = { output: '', exitCode: 0 };
      record('sandbox.exec', { cmd, ...(opts?.cwd ? { cwd: opts.cwd } : {}) }, {
        ...result,
        note: SIMULATED
      });
      return result;
    },
    async readFile(path) {
      return readPath('sandbox.readFile', path);
    },
    async writeFile(path, contents) {
      vfs.set(path, contents);
      record('sandbox.writeFile', { path, bytes: contents.length });
    }
  };

  const files: FilesContext = {
    async read(path) {
      return readPath('files.read', path);
    },
    async write(path, contents) {
      vfs.set(path, contents);
      record('files.write', { path, bytes: contents.length });
    }
  };

  const llm: LlmContext = {
    async complete(prompt, opts) {
      record('llm.complete', {
        promptChars: prompt.length,
        ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {})
      }, { note: SIMULATED });
      return SIMULATED;
    }
  };

  const memory: MemoryContext = {
    async save(content, opts) {
      const id = `sim-mem-${++memorySeq}`;
      record('memory.save', {
        contentChars: content.length,
        ...(opts?.scope ? { scope: opts.scope } : {}),
        ...(opts?.tags ? { tags: opts.tags } : {})
      }, { id });
      return { id };
    },
    async recall(query, opts) {
      const items: MemoryItem[] = [];
      record('memory.recall', {
        query,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {})
      }, { items: 0 });
      return items;
    }
  };

  const workflow: WorkflowContext = {
    async run(name, args) {
      const runId = `sim-wf-${++workflowSeq}`;
      record('workflow.run', { name, ...(args ? { args } : {}) }, { runId, note: SIMULATED });
      return {
        runId,
        async completion() {
          return { output: null, status: 'success' as const };
        }
      };
    },
    async status(runId) {
      record('workflow.status', { runId }, { status: 'success' });
      return { status: 'success' as const };
    }
  };

  const schedule: ScheduleContext = {
    async at(when, payload) {
      record('schedule.at', { when: when.toISOString(), payload }, { note: SIMULATED });
    },
    async cancel(name) {
      record('schedule.cancel', { name }, { note: SIMULATED });
    }
  };

  const log: WorkforceCtx['log'] = (level, message, attrs) => {
    sink.logs.push({
      t: now().toISOString(),
      level,
      message,
      ...(attrs ? { attrs } : {})
    });
  };

  const harnessRunner = async (args: HarnessRunArgs): Promise<HarnessRunResult> => {
    const result: HarnessRunResult = { output: SIMULATED, exitCode: 0, durationMs: 0 };
    record('harness.run', {
      promptChars: args.prompt.length,
      ...(args.cwd ? { cwd: args.cwd } : {})
    }, { exitCode: 0, note: SIMULATED });
    return result;
  };

  return {
    sandbox,
    files,
    llm,
    memory,
    workflow,
    schedule,
    log,
    harnessRunner,
    useSink(next) {
      sink = next;
    },
    vfsSnapshot() {
      return Object.fromEntries(vfs.entries());
    }
  };
}
