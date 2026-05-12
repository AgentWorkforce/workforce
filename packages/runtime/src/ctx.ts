import type { PersonaSpec } from '@agentworkforce/persona-kit';
import type {
  LlmContext,
  MemoryContext,
  ScheduleContext,
  SandboxContext,
  WorkforceCtx,
  WorkflowContext
} from './types.js';

/**
 * Options passed to `buildCtx` when the runner cold-starts. The deploy
 * package supplies these from the bundle metadata + environment.
 *
 * Required subsystems (`sandbox`, `harnessRunner`) must always be
 * provided — there is no sensible default for spawning a harness or
 * executing inside an isolated filesystem. Optional subsystems
 * (`llm`, `memory`, `workflow`, `schedule`, `log`, `integrations`)
 * fall back to documented defaults: `memory` becomes a no-op (so
 * `ctx.memory.save(...)` is safe to call from any handler), the rest
 * throw with a single-line "not configured" message that names the
 * persona-side flag a caller would set to enable them.
 */
export interface CtxBuildOptions {
  persona: PersonaSpec;
  workspaceId: string;
  agentName?: string;
  sandbox: SandboxContext;
  llm?: LlmContext;
  memory?: MemoryContext;
  workflow?: WorkflowContext;
  schedule?: ScheduleContext;
  integrations?: Record<string, unknown>;
  log?: WorkforceCtx['log'];
  harnessRunner: WorkforceCtx['harness']['run'];
}

const NOOP_MEMORY: MemoryContext = {
  async save() {
    /* memory disabled (persona.memory unset) — saves silently no-op */
  },
  async recall() {
    return [];
  }
};

const UNAVAILABLE_LLM: LlmContext = {
  async complete() {
    throw new Error(
      'ctx.llm is unavailable: set persona.useSubscription:true and connect a provider, or pass a workforce-billed LlmContext to buildCtx.'
    );
  }
};

const UNAVAILABLE_WORKFLOW: WorkflowContext = {
  async run() {
    throw new Error(
      'ctx.workflow is unavailable: the runner is not connected to the workforce workflows API (workspace token missing).'
    );
  },
  async status() {
    throw new Error(
      'ctx.workflow is unavailable: the runner is not connected to the workforce workflows API (workspace token missing).'
    );
  }
};

const UNAVAILABLE_SCHEDULE: ScheduleContext = {
  async at() {
    throw new Error(
      'ctx.schedule.at is unavailable: connect the runner to a scheduler (relaycron or workforce cloud) before scheduling follow-ups.'
    );
  },
  async cancel() {
    throw new Error(
      'ctx.schedule.cancel is unavailable: connect the runner to a scheduler (relaycron or workforce cloud) before canceling schedules.'
    );
  }
};

function defaultLog(level: string, message: string, attrs?: Record<string, unknown>): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...(attrs ?? {}) });
  stream.write(`${line}\n`);
}

/**
 * Compose a WorkforceCtx from the deploy-supplied subsystems. Subsystems
 * left unset fall back to the documented defaults at the top of this
 * file — handlers that depend on an unavailable subsystem fail with a
 * clear runtime error rather than silently dropping work.
 */
export function buildCtx(options: CtxBuildOptions): WorkforceCtx {
  const ctx: WorkforceCtx = {
    persona: options.persona,
    workspaceId: options.workspaceId,
    agentName: options.agentName ?? options.persona.id,
    llm: options.llm ?? UNAVAILABLE_LLM,
    harness: { run: options.harnessRunner },
    sandbox: options.sandbox,
    memory: options.memory ?? NOOP_MEMORY,
    workflow: options.workflow ?? UNAVAILABLE_WORKFLOW,
    schedule: options.schedule ?? UNAVAILABLE_SCHEDULE,
    log: options.log ?? defaultLog
  };

  // Per-integration clients attach as named ctx fields. The deploy step
  // decides the concrete shape of each client — `github` is a typed
  // `GithubClient`, others are `unknown` until they ship. Handlers
  // narrow with a runtime check (`if (ctx.linear)`) and cast against
  // the future client interface.
  //
  // Reserved fields are guarded so a malformed persona that declares
  // an integration named `harness` or `sandbox` cannot clobber core
  // ctx subsystems — that would silently turn `ctx.harness.run(...)`
  // into a call against an attacker-controlled object.
  if (options.integrations) {
    for (const [provider, client] of Object.entries(options.integrations)) {
      if (CORE_CTX_FIELDS.has(provider)) {
        throw new Error(
          `runtime: integration provider "${provider}" collides with a core ctx field; rename the integration in your persona JSON`
        );
      }
      Object.assign(ctx, { [provider]: client });
    }
  }

  return ctx;
}

const CORE_CTX_FIELDS: ReadonlySet<string> = new Set([
  'persona',
  'workspaceId',
  'agentName',
  'llm',
  'harness',
  'sandbox',
  'memory',
  'workflow',
  'schedule',
  'log'
]);
