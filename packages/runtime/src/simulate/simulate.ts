import { randomUUID } from 'node:crypto';
import { buildCtx } from '../ctx.js';
import { isWorkforceHandler } from '../handler.js';
import { type RawGatewayEnvelope } from '../shim.js';
import { envelopeToAgentEvent } from '../to-agent-event.js';
import { isCronTickEvent } from '@agent-relay/events';
import type {
  WorkforceAgentContext,
  WorkforceDeploymentContext,
  WorkforceEvent,
  WorkforceHandler
} from '../types.js';
import { deriveSimulatedRunFailureClass } from './failure-class.js';
import { createSimulationSubsystems, type SimulationSink } from './subsystems.js';
import type {
  CapturedLogLine,
  SimulateInvocationOptions,
  SimulatedRunRecord,
  SimulationResult,
  UnsupportedEnvelope
} from './types.js';

/**
 * TRUE invocation dry-run: execute the persona's handler against fixture
 * envelopes with every external side effect recorded-not-executed, and
 * emit one Cloud-compatible run record per dispatched envelope
 * (`origin: "local_dry_run"`).
 *
 * This is distinct from the deploy-preflight `--dry-run` (which validates
 * persona/config and exits without ever invoking the handler). Dispatch
 * semantics mirror `startRunner`: envelopes are shimmed with the same
 * `shimEnvelope`, unsupported envelopes are skipped (reported, not fatal),
 * handler errors are caught per envelope and never abort the replay.
 *
 * Envelopes are materialized up front — fixture replay is finite by
 * definition; this is not a long-lived stream consumer.
 */
export async function simulateInvocation(
  options: SimulateInvocationOptions
): Promise<SimulationResult> {
  const handlerFn = options.handler as WorkforceHandler;
  if (typeof handlerFn !== 'function') {
    throw new TypeError('simulateInvocation: options.handler must be a function');
  }
  if (!isWorkforceHandler(handlerFn)) {
    // Same soft acceptance as startRunner: raw functions work, branded
    // handlers are preferred. No stderr noise in simulation — the caller
    // owns presentation.
  }

  const now = options.now ?? (() => new Date());
  const runIdFactory = options.runIdFactory ?? (() => `sim_${randomUUID()}`);

  const envelopes: RawGatewayEnvelope[] = [];
  for await (const envelope of toAsyncIterable(options.envelopes)) {
    envelopes.push(envelope);
  }

  const workspaceId =
    options.workspaceId ?? envelopes[0]?.workspace ?? 'ws-simulation';

  const agent: WorkforceAgentContext & {
    inputValues?: Record<string, string | number | boolean | null | undefined>;
  } = {
    id: options.agent?.id ?? 'sim-agent',
    deployedName: options.agent?.deployedName ?? options.persona.id,
    spawnedByAgentId: options.agent?.spawnedByAgentId ?? null,
    ...(options.agent?.inputValues ? { inputValues: options.agent.inputValues } : {})
  };

  const deployment: WorkforceDeploymentContext = {
    id: options.deployment?.id ?? 'sim-deployment',
    triggerKind: options.deployment?.triggerKind ?? 'inbox',
    parentDeploymentId: options.deployment?.parentDeploymentId ?? null
  };
  const explicitTriggerKind = options.deployment?.triggerKind;

  const subsystems = createSimulationSubsystems({
    ...(options.files ? { files: options.files } : {}),
    now
  });

  // buildCtx may throw for unresolved required persona inputs — that is a
  // simulation setup error (seed inputs via `agent.inputValues`), surfaced
  // to the caller before any run records exist.
  const ctx = buildCtx({
    persona: options.persona,
    agent,
    deployment,
    workspaceId,
    sandbox: subsystems.sandbox,
    files: subsystems.files,
    llm: subsystems.llm,
    memory: subsystems.memory,
    workflow: subsystems.workflow,
    schedule: subsystems.schedule,
    log: subsystems.log,
    harnessRunner: subsystems.harnessRunner
  });

  const startedAtDate = now();
  const runs: SimulatedRunRecord[] = [];
  const unsupported: UnsupportedEnvelope[] = [];

  for (const raw of envelopes) {
    const event = envelopeToAgentEvent(raw);
    if (!event) {
      unsupported.push({ id: raw.id ?? '(missing id)', type: raw.type ?? '(missing type)' });
      continue;
    }

    const sink: SimulationSink = { sideEffects: [], logs: [] };
    subsystems.useSink(sink);

    const runStarted = now();
    let summary: string | null = null;
    let error: string | null = null;
    try {
      const returned: unknown = await handlerFn(ctx, event);
      summary = summaryFromHandlerReturn(returned);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const runEnded = now();

    const status: 'succeeded' | 'failed' = error === null ? 'succeeded' : 'failed';
    runs.push({
      runId: runIdFactory(),
      deploymentId: deployment.id,
      agentId: agent.id,
      status,
      exitCode: error === null ? 0 : 1,
      summary: summary ?? (error !== null ? error : null),
      error,
      startedAt: runStarted.toISOString(),
      endedAt: runEnded.toISOString(),
      durationMs: runEnded.getTime() - runStarted.getTime(),
      trigger: {
        kind: explicitTriggerKind ?? triggerKindForEvent(event),
        eventSource: isCronTickEvent(event) ? 'cron' : event.resource.provider
      },
      sandbox: { id: null, name: 'local-simulation' },
      failureClass: deriveSimulatedRunFailureClass({ status, error }),
      origin: 'local_dry_run',
      logs: {
        stdout: renderLogLines(sink.logs, ['debug', 'info']),
        stderr: renderLogLines(sink.logs, ['warn', 'error']),
        mountLogTail: '',
        stdoutTruncated: false,
        stderrTruncated: false
      },
      simulation: {
        mode: 'simulate',
        sideEffects: sink.sideEffects,
        capturedLogs: sink.logs
      }
    });
  }

  const endedAtDate = now();
  const succeeded = runs.filter((run) => run.status === 'succeeded').length;
  const failed = runs.length - succeeded;

  return {
    origin: 'local_dry_run',
    mode: 'simulate',
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
    runs,
    unsupported,
    summary: {
      total: runs.length,
      succeeded,
      failed,
      unsupported: unsupported.length
    },
    exitCode: failed > 0 ? 1 : 0
  };
}

/**
 * Handlers are typed `Promise<void> | void`, but raw handlers may return a
 * value. A string return (or an object carrying a string `summary`) becomes
 * the run record's `summary` so Cloud's list view shows something
 * meaningful; anything else is ignored.
 */
function summaryFromHandlerReturn(returned: unknown): string | null {
  if (typeof returned === 'string' && returned.trim().length > 0) {
    return returned;
  }
  if (
    typeof returned === 'object' &&
    returned !== null &&
    'summary' in returned &&
    typeof (returned as { summary: unknown }).summary === 'string' &&
    (returned as { summary: string }).summary.trim().length > 0
  ) {
    return (returned as { summary: string }).summary;
  }
  return null;
}

/**
 * Map an event source onto the workforce trigger vocabulary Cloud's
 * `trigger_kind` column stores: cron ticks are `clock`, provider events
 * are `inbox`. An explicit deployment.triggerKind override wins (handled
 * by the caller).
 */
function triggerKindForEvent(event: WorkforceEvent): string {
  return isCronTickEvent(event) ? 'clock' : 'inbox';
}

function renderLogLines(
  logs: CapturedLogLine[],
  levels: ReadonlyArray<CapturedLogLine['level']>
): string {
  // Mirrors the runner's stream split: debug/info → stdout, warn/error →
  // stderr, one JSON line per emission (same shape defaultRunnerLog writes).
  return logs
    .filter((line) => levels.includes(line.level))
    .map((line) =>
      JSON.stringify({ t: line.t, level: line.level, message: line.message, ...(line.attrs ?? {}) })
    )
    .join('\n');
}

function toAsyncIterable<T>(
  value: Iterable<T> | AsyncIterable<T>
): AsyncIterable<T> {
  if (Symbol.asyncIterator in (value as AsyncIterable<T>)) {
    return value as AsyncIterable<T>;
  }
  const iterable = value as Iterable<T>;
  return (async function* () {
    for (const item of iterable) yield item;
  })();
}
