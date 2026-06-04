import type {
  AgentSpec,
  PersonaSchedule,
  TypedTriggerMap,
  WatchRule
} from '@agentworkforce/persona-kit';
import { handler as brandHandler } from './handler.js';
import type {
  WorkforceCronEvent,
  WorkforceCtx,
  WorkforceEvent,
  WorkforceHandler,
  WorkforceHandlerExport,
  LinearAgentSessionEvent,
  WorkforceProviderEvent
} from './types.js';

// ---------------------------------------------------------------------------
// Event-type narrowing
//
// `defineAgent` flows the literal triggers/schedules an author declares into
// the handler's `event` parameter so `event.type` autocompletes to exactly the
// declared trigger `on` values and `event.name` to the declared schedule
// names. This is best-effort: when neither triggers nor schedules are present
// (or the literals can't be resolved), the handler falls back to the full
// `WorkforceEvent` union. `source` is intentionally left at its base type —
// agents trigger on providers outside the closed `WorkforceEventSource` enum
// (e.g. `granola`, `google-mail`), so narrowing it would fight reality.
// ---------------------------------------------------------------------------

/** Distributive union of every `on` literal declared across a triggers map. */
type OnLiteralsOf<A> = A extends readonly (infer E)[]
  ? E extends { on: infer O }
    ? Extract<O, string>
    : never
  : never;

type TriggerOnUnion<Tr> = OnLiteralsOf<NonNullable<Tr[keyof Tr]>>;

type LinearSpecialEvent<O extends string> = Extract<LinearAgentSessionEvent, { type: O }>;

type ProviderEventFor<P extends string, O extends string> = P extends 'linear'
  ? [LinearSpecialEvent<O>] extends [never]
    ? Omit<WorkforceProviderEvent, 'type'> & { type: O }
    : LinearSpecialEvent<O>
  : Omit<WorkforceProviderEvent, 'type'> & { type: O };

type TriggerProviderEvents<Tr> = {
  [P in keyof Tr]: P extends string
    ? OnLiteralsOf<NonNullable<Tr[P]>> extends infer O
      ? O extends string
        ? ProviderEventFor<P, O>
        : never
      : never
    : never;
}[keyof Tr];

type NarrowedProviderEvent<Tr> = [TriggerOnUnion<Tr>] extends [never]
  ? never
  : TriggerProviderEvents<Tr>;

/** Distributive union of every schedule `name` literal. */
type ScheduleNameUnion<S> = S extends readonly (infer E)[]
  ? E extends { name: infer N }
    ? Extract<N, string>
    : never
  : never;

type NarrowedCronEvent<S> = [ScheduleNameUnion<S>] extends [never]
  ? never
  : Omit<WorkforceCronEvent, 'name'> & { name: ScheduleNameUnion<S> };

/**
 * The discriminated event a `defineAgent` handler receives, narrowed to the
 * declared triggers/schedules. Falls back to the full {@link WorkforceEvent}
 * union when nothing narrowable is declared.
 */
export type AgentEvent<Tr, S> = [
  NarrowedProviderEvent<Tr> | NarrowedCronEvent<S>
] extends [never]
  ? WorkforceEvent
  : NarrowedProviderEvent<Tr> | NarrowedCronEvent<S>;

/**
 * Authoring shape of an agent (`agent.ts`). The persona says *what the agent
 * is* (model, harness, skills, mcp, integration connections); the agent says
 * *when/how it fires* (triggers, schedules, watch) and *what it does* (the
 * handler).
 *
 * `triggers` is a provider-keyed map (`{ github: [{ on: '...' }], … }`) whose
 * keys mirror `persona.integrations` so the deploy CLI joins events→connection.
 */
export interface AgentDefinition<
  Tr extends TypedTriggerMap = TypedTriggerMap,
  S extends readonly PersonaSchedule[] = readonly PersonaSchedule[]
> {
  /**
   * Alternate launch path for agents without direct listeners. Team members are
   * spawned by a dispatcher agent, so they intentionally declare no triggers,
   * schedules, or watch rules.
   */
  launchedBy?: AgentSpec['launchedBy'];
  /** Radio listeners: provider-keyed map of typed event triggers. */
  triggers?: Tr;
  /** Clock listeners: cron schedules. */
  schedules?: S;
  /** Relayfile-change listeners. */
  watch?: readonly WatchRule[];
  /** Event handler. `event` is narrowed to the declared triggers/schedules. */
  handler: (ctx: WorkforceCtx, event: AgentEvent<Tr, S>) => Promise<void> | void;
}

/**
 * Branded object returned by {@link defineAgent}. The deploy CLI reads
 * `triggers`/`schedules`/`watch` off this default export to build the cloud
 * `agent` block, and the runner invokes `handler`.
 */
export interface WorkforceAgentExport {
  readonly __workforceAgent: true;
  readonly launchedBy?: AgentSpec['launchedBy'];
  readonly triggers?: TypedTriggerMap;
  readonly schedules?: readonly PersonaSchedule[];
  readonly watch?: readonly WatchRule[];
  readonly handler: WorkforceHandlerExport;
}

/**
 * Define a workforce agent. Default-export the result from `agent.ts`:
 *
 * ```ts
 * import { defineAgent } from '@agentworkforce/runtime';
 *
 * export default defineAgent({
 *   triggers: {
 *     github: [{ on: 'pull_request.opened' }, { on: 'issue_comment.created', match: '@mention' }],
 *     slack: [{ on: 'app_mention' }],
 *   },
 *   schedules: [{ name: 'nightly', cron: '0 2 * * *' }],
 *   handler: async (ctx, event) => {
 *     // event.type narrows to the declared trigger `on` values
 *   },
 * });
 * ```
 *
 * Identity-ish at runtime: returns the same listener declarations plus a
 * branded, `handler()`-wrapped handler. The `const` type params preserve the
 * authored literals so the handler's `event` can be narrowed.
 */
export function defineAgent<
  const Tr extends TypedTriggerMap = Record<string, never>,
  const S extends readonly PersonaSchedule[] = []
>(input: AgentDefinition<Tr, S>): WorkforceAgentExport {
  if (!input || typeof input !== 'object') {
    throw new TypeError('defineAgent() expects an object');
  }
  if (typeof input.handler !== 'function') {
    throw new TypeError('defineAgent({ handler }) — handler must be a function');
  }
  const agent: {
    launchedBy?: AgentSpec['launchedBy'];
    triggers?: TypedTriggerMap;
    schedules?: readonly PersonaSchedule[];
    watch?: readonly WatchRule[];
    handler: WorkforceHandlerExport;
  } = {
    ...(input.launchedBy ? { launchedBy: input.launchedBy } : {}),
    ...(input.triggers ? { triggers: input.triggers as TypedTriggerMap } : {}),
    ...(input.schedules ? { schedules: input.schedules } : {}),
    ...(input.watch ? { watch: input.watch } : {}),
    handler: brandHandler(input.handler as WorkforceHandler)
  };
  Object.defineProperty(agent, '__workforceAgent', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
  return agent as WorkforceAgentExport;
}

/**
 * Detect whether a bundle's default export is a branded {@link defineAgent}
 * object. Used by the runner to extract the handler before invoking it.
 */
export function isWorkforceAgent(value: unknown): value is WorkforceAgentExport {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __workforceAgent?: unknown }).__workforceAgent === true &&
    typeof (value as { handler?: unknown }).handler === 'function'
  );
}
