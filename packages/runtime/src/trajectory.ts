import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TrajectoryClient,
  type Alternative,
  type Decision,
  type TrajectorySession,
  type Trajectory
} from 'agent-trajectories/sdk';
import { isCronTickEvent } from '@agent-relay/events';
import type {
  CompactedTrajectoryContract,
  TrajectoryContext,
  TrajectoryDecisionRecord,
  WorkforceCtx,
  WorkforceEvent
} from './types.js';

/** Stable display label for an event's origin (provider slug, or `cron`). */
function eventSourceLabel(event: WorkforceEvent): string {
  return isCronTickEvent(event) ? 'cron' : event.resource.provider;
}

/**
 * Per-run trajectory recorder. Wraps the `agent-trajectories` SDK so the
 * runtime can auto-record a decision trajectory (the WHY) around every
 * handler invocation and emit a compacted, contract-shaped artifact on
 * completion. The compacted artifact is the A↔B interface consumed by the
 * ai-hist trajectory sync source.
 *
 * Lifecycle (driven by the runner dispatch loop):
 *   begin(event) → [handler calls ctx.trajectory.note/decide/...] → complete()
 *                                                                  ↘ fail(err)
 *
 * `context` is the handler-facing surface attached to `ctx.trajectory`.
 * Every recording operation is best-effort: a failure inside the recorder
 * is logged and swallowed so it can never break the run it is observing.
 */
export interface TrajectoryRecorder {
  /** Handler-facing surface attached to `ctx.trajectory`. */
  readonly context: TrajectoryContext;
  /** Start a trajectory for a single run. */
  begin(event: WorkforceEvent): Promise<void>;
  /** Finish the active run (no-op if the handler already called `done`). */
  complete(): Promise<void>;
  /** Record a handler error and abandon the active run. */
  fail(error: unknown): Promise<void>;
}

export interface TrajectoryRecorderOptions {
  /** Persona id — scopes the store and stamps every contract artifact. */
  personaId: string;
  /** Logical agent name recorded as the trajectory's participant. */
  agentName: string;
  /** Workspace the run belongs to (projectId fallback + tag). */
  workspaceId: string;
  /**
   * Persona `recordTrajectories` flag. `false` disables recording entirely;
   * `undefined`/`true` keep it on (subject to a resolvable root).
   */
  recordTrajectories?: boolean;
  /**
   * Explicit trajectory root. When omitted the recorder falls back to
   * `env.TRAJECTORY_ROOT`. If neither resolves, recording is disabled — the
   * runtime never silently writes to the process cwd. The cloud runtime sets
   * this to the same value it passes to the ai-hist MCP so the MCP reads back
   * exactly what the runtime wrote.
   */
  trajectoryRoot?: string;
  /** Explicit project id; otherwise derived from env then workspaceId. */
  projectId?: string;
  /** Structured logger (warnings only — recording never throws). */
  log: WorkforceCtx['log'];
  /** Environment source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * autoCompact passthrough for the SDK (runs `trail compact` on done).
   * Defaults to `{ mechanical: true, markdown: true }`, or `false` when
   * `WORKFORCE_TRAJECTORY_AUTOCOMPACT` is `0`/`false`. Tests pass `false`.
   */
  autoCompact?: boolean | { mechanical?: boolean; markdown?: boolean };
}

const DEFAULT_CONFIDENCE = 0.8;
const AUTO_APPROACH = 'Auto-recorded by the workforce runtime.';

const NOOP_CONTEXT: TrajectoryContext = {
  async chapter() {},
  async note() {},
  async decide() {},
  async error() {},
  async done() {}
};

const NOOP_RECORDER: TrajectoryRecorder = {
  context: NOOP_CONTEXT,
  async begin() {},
  async complete() {},
  async fail() {}
};

/**
 * Build a trajectory recorder. Returns a no-op recorder when recording is
 * disabled (`recordTrajectories === false`) or when no trajectory root can be
 * resolved — both cases keep `ctx.trajectory.*` safe to call from any handler.
 */
export function createTrajectoryRecorder(options: TrajectoryRecorderOptions): TrajectoryRecorder {
  const env = options.env ?? process.env;
  if (options.recordTrajectories === false) return NOOP_RECORDER;
  const root = (options.trajectoryRoot ?? env.TRAJECTORY_ROOT)?.trim();
  if (!root) return NOOP_RECORDER;
  return new ActiveTrajectoryRecorder(options, env, root);
}

class ActiveTrajectoryRecorder implements TrajectoryRecorder {
  private readonly client: TrajectoryClient;
  private readonly root: string;
  private readonly personaId: string;
  private readonly projectId: string | null;
  private readonly log: WorkforceCtx['log'];
  private initialized = false;
  private session: TrajectorySession | null = null;
  private finalized = false;
  private currentEvent: WorkforceEvent | null = null;
  readonly context: TrajectoryContext;

  constructor(options: TrajectoryRecorderOptions, env: NodeJS.ProcessEnv, root: string) {
    this.root = root;
    this.personaId = options.personaId;
    this.log = options.log;
    this.projectId =
      firstNonEmpty(
        env.TRAJECTORIES_PROJECT,
        env.WORKFORCE_PROJECT_ID,
        options.projectId,
        options.workspaceId
      ) ?? null;
    this.client = new TrajectoryClient({
      dataDir: join(root, this.personaId),
      defaultAgent: options.agentName,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      autoSave: true,
      autoCompact: options.autoCompact ?? resolveAutoCompact(env)
    });
    this.context = {
      chapter: (title) => this.safe(() => this.session?.chapter(title)),
      note: (content) => this.safe(() => this.session?.note(content)),
      decide: (question, chosen, reasoning, alternatives) =>
        this.safe(() => this.session?.decide(question, chosen, reasoning, alternatives)),
      error: (content) => this.safe(() => this.session?.error(content)),
      done: (summary, confidence) => this.finalizeCompleted(summary, confidence)
    };
  }

  async begin(event: WorkforceEvent): Promise<void> {
    this.currentEvent = event;
    this.session = null;
    this.finalized = false;
    try {
      if (!this.initialized) {
        await this.client.init();
        this.initialized = true;
      }
      // Clear a stale active trajectory left by a crashed prior run so
      // `start()` does not reject with ACTIVE_TRAJECTORY_EXISTS.
      const active = await this.client.getActive();
      if (active) {
        const stale = await this.client.open(active.id);
        await stale?.abandon('superseded by a new run');
      }
      const { title, description } = describeEvent(event);
      this.session = await this.client.start(title, {
        ...(description ? { description } : {}),
        workflowId: workflowIdFor(event),
        tags: [`persona:${this.personaId}`, `workspace:${event.workspace}`, `source:${eventSourceLabel(event)}`]
      });
      await this.session.chapter(`handle ${eventLabel(event)}`);
    } catch (err) {
      this.session = null;
      this.warn('begin', err);
    }
  }

  async complete(): Promise<void> {
    if (!this.session || this.finalized) return;
    const title = this.currentEvent ? describeEvent(this.currentEvent).title : 'run';
    await this.finalizeCompleted(`Completed ${title}`, DEFAULT_CONFIDENCE);
  }

  async fail(error: unknown): Promise<void> {
    if (!this.session || this.finalized) return;
    this.finalized = true;
    const session = this.session;
    this.session = null;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await session.error(message);
      const trajectory = await session.abandon(message);
      await this.emitContract(trajectory);
    } catch (err) {
      this.warn('fail', err);
    }
  }

  private async finalizeCompleted(summary: string, confidence: number): Promise<void> {
    if (!this.session || this.finalized) return;
    this.finalized = true;
    const session = this.session;
    this.session = null;
    try {
      const trajectory = await session.complete({
        summary: summary.trim() || 'Run completed.',
        approach: AUTO_APPROACH,
        confidence: clampConfidence(confidence)
      });
      await this.emitContract(trajectory);
    } catch (err) {
      this.warn('complete', err);
    }
  }

  private async emitContract(trajectory: Trajectory): Promise<void> {
    const contract = toContract(trajectory, this.personaId, this.projectId);
    const dir = join(this.root, this.personaId, 'compacted');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${trajectory.id}.json`), `${JSON.stringify(contract, null, 2)}\n`);
  }

  private async safe(op: () => Promise<unknown> | undefined): Promise<void> {
    if (!this.session || this.finalized) return;
    try {
      await op();
    } catch (err) {
      this.warn('record', err);
    }
  }

  private warn(stage: string, err: unknown): void {
    this.log('warn', `trajectory.${stage}.failed`, {
      persona: this.personaId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Project a completed/abandoned raw trajectory into the locked A↔B contract
 * shape. Decisions are flattened from chapter `decision` events plus the
 * retrospective; the retrospective is projected to its contract subset.
 */
export function toContract(
  trajectory: Trajectory,
  personaId: string,
  projectId: string | null
): CompactedTrajectoryContract {
  const retrospective = trajectory.retrospective
    ? {
        summary: trajectory.retrospective.summary,
        approach: trajectory.retrospective.approach,
        learnings: trajectory.retrospective.learnings ?? [],
        confidence: trajectory.retrospective.confidence
      }
    : null;

  return {
    id: trajectory.id,
    version: trajectory.version,
    personaId,
    projectId: projectId ?? trajectory.projectId ?? null,
    task: {
      title: trajectory.task.title,
      description: trajectory.task.description ?? null
    },
    status: trajectory.status,
    startedAt: trajectory.startedAt,
    completedAt: trajectory.completedAt ?? null,
    decisions: collectDecisions(trajectory),
    retrospective
  };
}

function collectDecisions(trajectory: Trajectory): TrajectoryDecisionRecord[] {
  const out: TrajectoryDecisionRecord[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const decision = normalizeDecision(raw);
    if (!decision) return;
    const key = `${decision.question} ${decision.chosen}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(decision);
  };
  for (const chapter of trajectory.chapters) {
    for (const event of chapter.events) {
      if (event.type === 'decision' && event.raw) push(event.raw);
    }
  }
  for (const decision of trajectory.retrospective?.decisions ?? []) push(decision);
  return out;
}

function normalizeDecision(raw: unknown): TrajectoryDecisionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const decision = raw as Partial<Decision>;
  return {
    question: decision.question ?? '',
    chosen: decision.chosen ?? '',
    reasoning: decision.reasoning ?? '',
    alternatives: normalizeAlternatives(decision.alternatives)
  };
}

function normalizeAlternatives(alternatives: Decision['alternatives'] | undefined): Array<{ option: string; reason?: string }> {
  if (!Array.isArray(alternatives)) return [];
  return alternatives.map((alternative) => {
    // The SDK schema accepts both string[] (legacy) and Alternative[].
    if (typeof alternative === 'string') return { option: alternative };
    const alt = alternative as Alternative;
    return {
      option: alt.option ?? '',
      ...(alt.reason ? { reason: alt.reason } : {})
    };
  });
}

function describeEvent(event: WorkforceEvent): { title: string; description?: string } {
  if (isCronTickEvent(event)) {
    return {
      title: `cron:${event.schedule}`,
      description: `cron schedule "${event.schedule}" fired for ${event.scheduledFor}`
    };
  }
  const source = eventSourceLabel(event);
  const title = event.summary?.title?.trim() || `${source}:${event.type}`;
  return { title, description: `${source} ${event.type} — event ${event.id}` };
}

function eventLabel(event: WorkforceEvent): string {
  return isCronTickEvent(event) ? 'cron:tick' : `${eventSourceLabel(event)}:${event.type}`;
}

function workflowIdFor(event: WorkforceEvent): string {
  return `run_${event.id.replace(/[^A-Za-z0-9_-]/g, '_')}_${event.attempt}`;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function resolveAutoCompact(env: NodeJS.ProcessEnv): false | { mechanical: boolean; markdown: boolean } {
  const disabled = env.WORKFORCE_TRAJECTORY_AUTOCOMPACT?.trim().toLowerCase();
  if (disabled === '0' || disabled === 'false') return false;
  return { mechanical: true, markdown: true };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

const RECORDER_KEY = Symbol.for('workforce.runtime.trajectoryRecorder');

/** Attach a recorder to a ctx so the runner can drive its lifecycle. */
export function attachTrajectoryRecorder(ctx: WorkforceCtx, recorder: TrajectoryRecorder): void {
  Object.defineProperty(ctx, RECORDER_KEY, {
    value: recorder,
    enumerable: false,
    configurable: true,
    writable: false
  });
}

/** Read the recorder the ctx was built with (no-op recorder when absent). */
export function getTrajectoryRecorder(ctx: WorkforceCtx): TrajectoryRecorder {
  const recorder = (ctx as unknown as Record<PropertyKey, unknown>)[RECORDER_KEY];
  return (recorder as TrajectoryRecorder | undefined) ?? NOOP_RECORDER;
}
