import type { PersonaSpec } from '@agentworkforce/persona-kit';
import type { RawGatewayEnvelope } from '../shim.js';
import type {
  WorkforceAgentContext,
  WorkforceDeploymentContext,
  WorkforceHandler,
  WorkforceHandlerExport
} from '../types.js';
import type { SimulatedRunFailureClass } from './failure-class.js';

/**
 * One intercepted subsystem call. Simulation never executes external
 * effects — every call a handler makes through ctx is recorded here with
 * the simulated result it received instead.
 */
export interface RecordedSideEffect {
  /** Which ctx channel the handler called, e.g. `memory.save`. */
  kind:
    | 'harness.run'
    | 'llm.complete'
    | 'sandbox.exec'
    | 'sandbox.readFile'
    | 'sandbox.writeFile'
    | 'files.read'
    | 'files.write'
    | 'memory.save'
    | 'memory.recall'
    | 'workflow.run'
    | 'workflow.status'
    | 'schedule.at'
    | 'schedule.cancel';
  /** ISO timestamp the call was made. */
  at: string;
  /** Call arguments, normalized to a plain record for serialization. */
  args: Record<string, unknown>;
  /** Summary of the simulated value returned to the handler. */
  simulatedResult?: unknown;
}

/** A single captured `ctx.log(...)` emission. */
export interface CapturedLogLine {
  t: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attrs?: Record<string, unknown>;
}

/**
 * Machine-readable record for one simulated invocation (one envelope).
 *
 * Field names and types MIRROR Cloud's hosted compact run shape
 * (cloud `packages/web/lib/proactive-runtime/deployment-run-observability.ts`
 * `compactBase` + detail `logs`, AgentWorkforce/cloud#1788) with
 * `origin: "local_dry_run"` — the origin value Cloud reserved for exactly
 * this ingestion. Simulation-only data is nested under the additive
 * `simulation` key so the core shape stays byte-compatible.
 */
export interface SimulatedRunRecord {
  runId: string;
  deploymentId: string;
  agentId: string;
  /** Cloud status vocabulary: `succeeded` | `failed`. */
  status: 'succeeded' | 'failed';
  exitCode: number;
  /**
   * Populated from the handler's returned value when it returns a string
   * (or an object with a string `summary`), so Cloud's list view shows
   * something meaningful. Null when the handler returns nothing.
   */
  summary: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  trigger: {
    /** Workforce trigger vocabulary (`inbox` | `clock` | `radio`). */
    kind: string;
    eventSource: string;
  };
  sandbox: {
    id: string | null;
    name: string | null;
  };
  failureClass: SimulatedRunFailureClass;
  origin: 'local_dry_run';
  logs: {
    stdout: string;
    stderr: string;
    mountLogTail: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  /** Simulation-only extension; absent from hosted records. */
  simulation: {
    mode: 'simulate';
    sideEffects: RecordedSideEffect[];
    capturedLogs: CapturedLogLine[];
  };
}

/** Envelope the simulation could not shim into a dispatchable event. */
export interface UnsupportedEnvelope {
  id: string;
  type: string;
}

export interface SimulationResult {
  origin: 'local_dry_run';
  mode: 'simulate';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  runs: SimulatedRunRecord[];
  unsupported: UnsupportedEnvelope[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    unsupported: number;
  };
  /** 0 when every dispatched envelope succeeded; 1 when any failed. */
  exitCode: 0 | 1;
}

export interface SimulateInvocationOptions {
  /** Parsed persona JSON, same shape `startRunner` takes. */
  persona: PersonaSpec;
  /** The persona's `onEvent` handler (branded or raw function). */
  handler: WorkforceHandlerExport | WorkforceHandler;
  /** Fixture envelopes to replay, in order. */
  envelopes:
    | Iterable<RawGatewayEnvelope>
    | AsyncIterable<RawGatewayEnvelope>;
  /** Agent row context; a local placeholder is synthesized when omitted. */
  agent?: Partial<WorkforceAgentContext> & {
    inputValues?: Record<string, string | number | boolean | null | undefined>;
  };
  /** Deployment context; a local placeholder is synthesized when omitted. */
  deployment?: Partial<WorkforceDeploymentContext>;
  /**
   * Workspace id. Falls back to the first envelope's `workspace`, then
   * `ws-simulation`. Never read from the environment.
   */
  workspaceId?: string;
  /**
   * Seed contents for the simulated in-memory filesystem, keyed by path.
   * Reads of unseeded, unwritten paths fail with a clear message that
   * names this option.
   */
  files?: Record<string, string>;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /** Run id factory override for deterministic tests. */
  runIdFactory?: () => string;
}
