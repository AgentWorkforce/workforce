import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { buildCtx, type CtxBuildOptions } from './ctx.js';
import { isWorkforceHandler } from './handler.js';
import { shimEnvelope, type RawGatewayEnvelope } from './shim.js';
import type {
  HarnessRunArgs,
  HarnessRunResult,
  SandboxContext,
  WorkforceEvent,
  WorkforceHandler,
  WorkforceHandlerExport
} from './types.js';

export interface StartRunnerOptions {
  /** Parsed persona JSON. Required. */
  persona: PersonaSpec;
  /**
   * Default-exported handler from the bundled `agent.ts`. The runner
   * accepts both a branded `WorkforceHandlerExport` (preferred) and a raw
   * function (when the bundle was authored before the `handler()` wrapper
   * existed).
   */
  handler: WorkforceHandlerExport | WorkforceHandler;
  /**
   * Workspace identifier. Resolved from `WORKFORCE_WORKSPACE_ID` env when
   * not supplied. The runner refuses to start without one.
   */
  workspaceId?: string;
  /**
   * Subsystem overrides. Most callers leave these unset; the deploy
   * package's mode-specific entry points (`runDev`, `runSandbox`) supply
   * the wired-up versions. Tests pass in-memory fakes here.
   */
  subsystems?: Partial<Pick<CtxBuildOptions, 'sandbox' | 'llm' | 'memory' | 'workflow' | 'schedule' | 'log' | 'integrations'>>;
  /**
   * Source of raw envelopes to dispatch. The default reads NDJSON from
   * stdin so a parent process can write `RawGatewayEnvelope` lines and
   * read structured logs back on stdout — useful both in `--mode dev` and
   * inside a Daytona sandbox where stdin/stdout are the simplest contract.
   */
  envelopes?: AsyncIterable<RawGatewayEnvelope>;
  /**
   * Harness runner. Required because spawning a harness inside a sandbox
   * is mode-specific (Daytona exec vs local child_process). When omitted,
   * `ctx.harness.run` throws a clear error.
   */
  harnessRunner?: (args: HarnessRunArgs) => Promise<HarnessRunResult>;
}

const HARNESS_UNAVAILABLE: (args: HarnessRunArgs) => Promise<HarnessRunResult> = async () => {
  throw new Error(
    'ctx.harness.run is unavailable: this runner was started without a harnessRunner. Use `workforce deploy --mode sandbox` to run inside Daytona, or supply a harnessRunner via StartRunnerOptions.'
  );
};

const PROCESS_FS_SANDBOX: SandboxContext = {
  cwd: process.cwd(),
  async exec() {
    throw new Error(
      'ctx.sandbox.exec is unavailable: this runner was started without a SandboxContext. Use `workforce deploy --mode sandbox` to enable a Daytona sandbox.'
    );
  },
  async readFile() {
    throw new Error(
      'ctx.sandbox.readFile is unavailable: this runner was started without a SandboxContext.'
    );
  },
  async writeFile() {
    throw new Error(
      'ctx.sandbox.writeFile is unavailable: this runner was started without a SandboxContext.'
    );
  }
};

/**
 * Cold-start the agent. Returns a promise that resolves once the envelope
 * stream completes (in production this is essentially "never", since the
 * stream is a long-lived gateway WebSocket).
 *
 * The runner:
 *   1. Validates the handler is callable (branded or raw function).
 *   2. Builds a `WorkforceCtx` once, reused across invocations.
 *   3. Iterates the envelope stream, shims each envelope into a
 *      `WorkforceEvent`, dispatches to the handler.
 *   4. Catches handler errors, logs them with full attribution. The outer
 *      retry/backoff lives at the deploy layer (mode-specific), so this
 *      function doesn't attempt redelivery.
 */
export async function startRunner(options: StartRunnerOptions): Promise<void> {
  const handlerFn: WorkforceHandler = options.handler as WorkforceHandler;
  if (typeof handlerFn !== 'function') {
    throw new TypeError('startRunner: options.handler must be a function');
  }
  if (!isWorkforceHandler(handlerFn)) {
    // Soft warning, not an error — power users who import `@agent-relay/agent`
    // directly may export a raw function that still satisfies the shape.
    process.stderr.write(
      '[workforce-runtime] handler is not branded with `handler()` — accepting raw function, but prefer `export default handler(fn)`.\n'
    );
  }

  const workspaceId = options.workspaceId ?? process.env.WORKFORCE_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error(
      'startRunner: workspaceId is required (pass via options or set WORKFORCE_WORKSPACE_ID)'
    );
  }

  const ctx = buildCtx({
    persona: options.persona,
    workspaceId,
    sandbox: options.subsystems?.sandbox ?? PROCESS_FS_SANDBOX,
    harnessRunner: options.harnessRunner ?? HARNESS_UNAVAILABLE,
    ...(options.subsystems?.llm ? { llm: options.subsystems.llm } : {}),
    ...(options.subsystems?.memory ? { memory: options.subsystems.memory } : {}),
    ...(options.subsystems?.workflow ? { workflow: options.subsystems.workflow } : {}),
    ...(options.subsystems?.schedule ? { schedule: options.subsystems.schedule } : {}),
    ...(options.subsystems?.log ? { log: options.subsystems.log } : {}),
    ...(options.subsystems?.integrations ? { integrations: options.subsystems.integrations } : {})
  });

  ctx.log('info', 'runner.started', {
    persona: options.persona.id,
    workspaceId,
    schedules: options.persona.schedules?.map((s) => s.name) ?? [],
    integrations: options.persona.integrations ? Object.keys(options.persona.integrations) : []
  });

  const stream = options.envelopes ?? readEnvelopesFromStdin();
  for await (const raw of stream) {
    const event = shimEnvelope(raw);
    if (!event) {
      ctx.log('warn', 'runner.envelope.unsupported', { rawId: raw.id, rawType: raw.type });
      continue;
    }
    await dispatch(ctx, handlerFn, event);
  }

  ctx.log('info', 'runner.envelope-stream.ended', { persona: options.persona.id });
}

async function dispatch(
  ctx: Parameters<WorkforceHandler>[0],
  fn: WorkforceHandler,
  event: WorkforceEvent
): Promise<void> {
  const t0 = Date.now();
  try {
    await fn(ctx, event);
    ctx.log('info', 'runner.handler.ok', {
      eventId: event.id,
      source: event.source,
      type: event.source === 'cron' ? 'cron.tick' : event.type,
      durationMs: Date.now() - t0
    });
  } catch (err) {
    ctx.log('error', 'runner.handler.error', {
      eventId: event.id,
      source: event.source,
      type: event.source === 'cron' ? 'cron.tick' : event.type,
      attempt: event.attempt,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    // Surface the failure to the outer process so the deploy layer can
    // retry. Throwing here would tear down the for-await loop; the deploy
    // layer reads the structured log line above instead.
  }
}

async function* readEnvelopesFromStdin(): AsyncGenerator<RawGatewayEnvelope> {
  // Lazily parse NDJSON from stdin so the runner can be driven by any
  // parent process that can pipe envelope lines. Each line is a JSON
  // object; malformed lines are logged and skipped.
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of process.stdin) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk as Buffer);
    buffer += text;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as RawGatewayEnvelope;
          yield parsed;
        } catch (err) {
          process.stderr.write(
            `[workforce-runtime] failed to parse envelope line: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }
      nl = buffer.indexOf('\n');
    }
  }

  // Drain any trailing line that lacked a terminating newline. Log
  // parse failures with the same warning shape the per-line path uses,
  // so a stuck producer doesn't silently swallow envelopes.
  const tail = buffer.trim();
  if (tail.length > 0) {
    try {
      yield JSON.parse(tail) as RawGatewayEnvelope;
    } catch (err) {
      const excerpt = tail.length > 200 ? `${tail.slice(0, 200)}…` : tail;
      process.stderr.write(
        `[workforce-runtime] failed to parse trailing envelope line: ${
          err instanceof Error ? err.message : String(err)
        } — excerpt: ${excerpt}\n`
      );
    }
  }
}
