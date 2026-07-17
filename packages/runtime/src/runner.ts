import type { AgentSpec, PersonaSpec } from '@agentworkforce/persona-kit';
import { createCloudRuntimeDefaults } from './cloud-defaults.js';
import { buildCtx, type CtxBuildOptions } from './ctx.js';
import { getTrajectoryRecorder, type TrajectoryRecorder } from './trajectory.js';
import { isWorkforceHandler } from './handler.js';
import { type RawGatewayEnvelope } from './shim.js';
import { envelopeToAgentEvent } from './to-agent-event.js';
import { isCronTickEvent } from '@agent-relay/events';
import type {
  HarnessRunArgs,
  HarnessRunResult,
  WorkforceAgentContext,
  WorkforceDeploymentContext,
  WorkforceEvent,
  WorkforceHandler,
  WorkforceHandlerExport
} from './types.js';

export interface StartRunnerOptions {
  /** Parsed persona JSON. Required. */
  persona: PersonaSpec;
  /** Agent row metadata for the agent handling this event. */
  agent: WorkforceAgentContext & {
    input_values?: Record<string, string | number | boolean | null | undefined>;
    inputValues?: Record<string, string | number | boolean | null | undefined>;
  };
  /** Deployment row metadata for the trigger that fires this handler. */
  deployment: WorkforceDeploymentContext;
  /**
   * Default-exported handler from the bundled `agent.ts`. The runner
   * accepts both a branded `WorkforceHandlerExport` (preferred) and a raw
   * function (when the bundle was authored before the `handler()` wrapper
   * existed).
   */
  handler: WorkforceHandlerExport | WorkforceHandler;
  /**
   * Parsed agent listener spec (triggers/schedules/watch) extracted from the
   * `defineAgent` default export by the deploy CLI. Optional — used only for
   * startup logging; the runtime does not subscribe (the cloud gateway does).
   */
  agentSpec?: AgentSpec;
  /**
   * Exact package versions whose source contributed bytes to the deployed
   * agent bundle. Generated deploy runners read this from package.json and
   * pass it through unchanged for startup observability.
   */
  bundleManifest?: BundleManifest;
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
  subsystems?: Partial<Pick<CtxBuildOptions, 'sandbox' | 'files' | 'llm' | 'memory' | 'workflow' | 'schedule' | 'log' | 'integrations'>>;
  /**
   * Source of raw envelopes to dispatch. The default reads NDJSON from
   * stdin so a parent process can write `RawGatewayEnvelope` lines and
   * read structured logs back on stdout — useful both in `--mode dev` and
   * inside a Daytona sandbox where stdin/stdout are the simplest contract.
   */
  envelopes?: AsyncIterable<RawGatewayEnvelope>;
  /**
   * Harness runner override. When omitted, the runtime spawns the persona's
   * declared harness in the cloud workspace root (`/workspace` when present,
   * otherwise cwd).
   */
  harnessRunner?: (args: HarnessRunArgs) => Promise<HarnessRunResult>;
}

export interface BundlePackageVersion {
  readonly name: string;
  readonly version: string;
}

export interface BundleManifest {
  readonly schemaVersion: 1;
  readonly packages: readonly BundlePackageVersion[];
}

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

  const log = options.subsystems?.log;
  const cloudDefaults = createCloudRuntimeDefaults({
    persona: options.persona,
    agent: options.agent,
    deployment: options.deployment,
    workspaceId,
    log: log ?? defaultRunnerLog
  });
  const integrations = options.subsystems?.integrations ?? {};

  const ctx = buildCtx({
    persona: options.persona,
    agent: options.agent,
    deployment: options.deployment,
    workspaceId,
    sandbox: options.subsystems?.sandbox ?? cloudDefaults.sandbox,
    files: options.subsystems?.files ?? cloudDefaults.files,
    harnessRunner: options.harnessRunner ?? cloudDefaults.harnessRunner,
    ...(options.subsystems?.llm ?? cloudDefaults.llm
      ? { llm: options.subsystems?.llm ?? cloudDefaults.llm }
      : {}),
    ...(options.subsystems?.memory ? { memory: options.subsystems.memory } : {}),
    ...(options.subsystems?.workflow ?? cloudDefaults.workflow
      ? { workflow: options.subsystems?.workflow ?? cloudDefaults.workflow }
      : {}),
    ...(options.subsystems?.schedule ? { schedule: options.subsystems.schedule } : {}),
    ...(options.subsystems?.log ? { log: options.subsystems.log } : {}),
    // Recorder write-root resolved once by cloud-defaults; identical to the
    // value cloud-defaults passes to the ai-hist MCP. Undefined locally/in
    // tests (recording stays opt-in via TRAJECTORY_ROOT).
    ...(cloudDefaults.trajectoryRoot ? { trajectoryRoot: cloudDefaults.trajectoryRoot } : {}),
    ...(Object.keys(integrations).length > 0 ? { integrations } : {})
  });

  ctx.log('info', 'runner.started', {
    persona: options.persona.id,
    workspaceId,
    schedules: options.agentSpec?.schedules?.map((s) => s.name) ?? [],
    triggers: options.agentSpec?.triggers ? Object.keys(options.agentSpec.triggers) : [],
    integrations: options.persona.integrations ? Object.keys(options.persona.integrations) : [],
    ...(options.bundleManifest ? { bundleManifest: options.bundleManifest } : {})
  });

  const recorder = getTrajectoryRecorder(ctx);
  const stream = options.envelopes ?? readEnvelopesFromStdin();
  for await (const raw of stream) {
    const event = envelopeToAgentEvent(raw);
    if (!event) {
      ctx.log('warn', 'runner.envelope.unsupported', { rawId: raw.id, rawType: raw.type });
      continue;
    }
    await dispatch(ctx, handlerFn, event, recorder);
  }

  ctx.log('info', 'runner.envelope-stream.ended', { persona: options.persona.id });
}

function defaultRunnerLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...(attrs ?? {}) })}\n`);
}

async function dispatch(
  ctx: Parameters<WorkforceHandler>[0],
  fn: WorkforceHandler,
  event: WorkforceEvent,
  recorder: TrajectoryRecorder
): Promise<void> {
  const t0 = Date.now();
  // Open a trajectory for this run. The handler narrates via ctx.trajectory.*;
  // begin/complete/fail never throw (recording is best-effort observability).
  await recorder.begin(event);
  try {
    await fn(ctx, event);
    ctx.log('info', 'runner.handler.ok', {
      eventId: event.id,
      source: isCronTickEvent(event) ? 'cron' : event.resource.provider,
      type: event.type,
      durationMs: Date.now() - t0
    });
    // Auto-finalize (no-op if the handler already called ctx.trajectory.done).
    await recorder.complete();
  } catch (err) {
    ctx.log('error', 'runner.handler.error', {
      eventId: event.id,
      source: isCronTickEvent(event) ? 'cron' : event.resource.provider,
      type: event.type,
      attempt: event.attempt,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    await recorder.fail(err);
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
