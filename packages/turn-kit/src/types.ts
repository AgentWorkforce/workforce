import type {
  MemoryRecallOptions,
  MemorySaveOptions,
  WorkforceCtx
} from '@agentworkforce/runtime';

export interface TurnConversation {
  /** Transport or surface name, such as `telegram`, `slack`, or `relay`. */
  transport: string;
  /**
   * Stable transport-local identity. Include the thread/topic when separate
   * conversations on the same channel must not share history.
   */
  id: string;
}

export interface TurnHistoryEntry {
  content: string;
  createdAt?: string;
}

export type TurnRecallOrder = 'newest-first' | 'oldest-first';

export interface TurnMemoryOptions {
  /** Semantic query used by ctx.memory.recall. Tags enforce conversation isolation. */
  query?: string;
  /** Number of prior turn records supplied to the responder. Defaults to 8. */
  limit?: number;
  /** Defaults to `workspace`. */
  scope?: MemoryRecallOptions['scope'];
  /** Expiry for newly saved turns. */
  ttlSeconds?: MemorySaveOptions['ttlSeconds'];
  /**
   * Ordering of timestamp-less recall results. Cloud memory returns
   * newest-first; timestamped records are always sorted chronologically.
   */
  recallOrder?: TurnRecallOrder;
  /** Human-readable labels used by the default turn serializer. */
  userLabel?: string;
  assistantLabel?: string;
  /** Customize the record saved after confirmed delivery. */
  serialize?: (input: string, reply: string) => string;
  /**
   * Fail the turn when recall fails or a save returns no receipt. Leave false
   * for retryable chat handlers to avoid redelivering a reply after a late
   * memory failure.
   */
  required?: boolean;
}

export interface TurnContext {
  /** Short stable heading for logs and prompts. */
  title: string;
  /** Grounding text or instructions supplied to the responder. */
  content: string;
}

export interface TurnContextProviderArgs {
  ctx: WorkforceCtx;
  conversation: TurnConversation;
  input: string;
  /** Oldest first. */
  history: readonly TurnHistoryEntry[];
}

/**
 * Deterministic grounding extension point. Exact state, provider reads, and
 * index searches belong here; the model should synthesize only after these
 * providers have run.
 */
export interface TurnContextProvider<Name extends string = string> {
  readonly name: Name;
  /** Optional providers log and disappear when unavailable. Required providers fail closed. */
  readonly optional?: boolean;
  collect(
    args: TurnContextProviderArgs
  ): TurnContext | readonly TurnContext[] | null | undefined | Promise<
    TurnContext | readonly TurnContext[] | null | undefined
  >;
}

export interface TurnResponse {
  reply: string;
  /**
   * `false` skips persistence. A string replaces the default serialized
   * user/assistant record.
   */
  remember?: false | string;
}

export interface TurnResponderArgs {
  ctx: WorkforceCtx;
  conversation: TurnConversation;
  input: string;
  /** Oldest first. */
  history: readonly TurnHistoryEntry[];
  context: readonly TurnContext[];
  /**
   * Send an interim, read-only status line. Failures are logged and return
   * false; they never abort the final response.
   */
  acknowledge(message: string): Promise<boolean>;
}

export interface TurnRequest<Receipt = unknown> {
  conversation: TurnConversation;
  input: string;
  respond(args: TurnResponderArgs): TurnResponse | string | Promise<TurnResponse | string>;
  /**
   * Deliver the final reply on the inbound transport. This function must throw
   * on failure unless `confirmDelivery` is supplied.
   */
  deliver(reply: string): Receipt | Promise<Receipt>;
  /** Optional interim delivery surface. */
  acknowledge?: (message: string) => unknown | Promise<unknown>;
  /**
   * Receipt predicate for adapters that resolve both success and failure. A
   * false result throws before conversation memory is written.
   */
  confirmDelivery?: (receipt: Receipt) => boolean;
}

export interface TurnRunResult<Receipt = unknown> {
  reply: string;
  receipt: Receipt;
  context: readonly TurnContext[];
  acknowledgements: number;
  /** False when memory is disabled, skipped, or returned no save receipt. */
  memorySaved: boolean;
}

export interface TurnRunnerOptions<
  Providers extends readonly TurnContextProvider[] = readonly TurnContextProvider[]
> {
  /** Stable lowercase slug used in tags and logs. */
  namespace: string;
  /** Conversation memory is enabled by default. */
  memory?: false | TurnMemoryOptions;
  context?: Providers;
}

export interface TurnRunner {
  run<Receipt>(
    ctx: WorkforceCtx,
    request: TurnRequest<Receipt>
  ): Promise<TurnRunResult<Receipt>>;
}
