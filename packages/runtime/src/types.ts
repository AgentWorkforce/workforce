import type {
  PersonaInputSpec,
  PersonaSpec,
  PersonaMemoryScope
} from '@agentworkforce/persona-kit';
import type { GithubClient } from './clients/github.js';
import type { LinearClient } from './clients/linear.js';
import type { SlackClient } from './clients/slack.js';
import type { NotionClient } from './clients/notion.js';
import type { JiraClient } from './clients/jira.js';

/**
 * Source of an event delivered to a persona's `onEvent` handler. The
 * runtime narrows the rest of the envelope based on this discriminator.
 *
 * Sources today: `cron` (schedule tick), the Tier-1 Relayfile providers
 * (`github`, `linear`, `slack`, `notion`, `jira`). Additional sources land
 * as cloud proactive-runtime milestones M2/M3 ship.
 */
export type WorkforceEventSource =
  | 'cron'
  | 'github'
  | 'linear'
  | 'slack'
  | 'notion'
  | 'jira';

/** Common envelope fields every event carries, regardless of source. */
interface WorkforceEventBase {
  /** Stable, idempotency-safe identifier; the runtime dedupes on this. */
  id: string;
  /** ISO timestamp the event fired at the source (not at delivery). */
  occurredAt: string;
  /** Delivery attempt count, 1 for first delivery. */
  attempt: number;
  /** Workspace this event is scoped to. */
  workspaceId: string;
}

export interface WorkforceCronEvent extends WorkforceEventBase {
  source: 'cron';
  /** Schedule name as declared in the persona's `schedules[].name`. */
  name: string;
  /** The persona's resolved cron expression for the schedule. */
  cron: string;
}

/** Provider-specific event payload — kept loose for v1. */
export interface WorkforceProviderEvent extends WorkforceEventBase {
  source: Exclude<WorkforceEventSource, 'cron'>;
  /** Provider-normalized event name (e.g. `pull_request.opened`). */
  type: string;
  /** Raw provider payload, normalized by the Relayfile adapter. */
  payload: unknown;
  /** Optional summary the gateway computed (M2). Missing on M1. */
  summary?: {
    title?: string;
    status?: string;
    actor?: string;
    [key: string]: unknown;
  };
}

export type WorkforceEvent = WorkforceCronEvent | WorkforceProviderEvent;

/**
 * Result of a harness invocation. The runtime translates whatever the
 * underlying harness streamed into this minimal shape.
 */
export interface HarnessRunResult {
  /** Final stdout/output from the harness. */
  output: string;
  /** Process exit code; 0 on success. */
  exitCode: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Optional usage metadata emitted by a harness or launcher. */
  usage?: HarnessUsage;
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
  costUsd?: number;
  raw?: unknown;
}

export interface HarnessRunArgs {
  /** Prompt or task description handed to the harness. */
  prompt: string;
  /** Working directory inside the sandbox; defaults to ctx.sandbox.cwd. */
  cwd?: string;
  /** Override or extend the persona's `inputs` for this run. */
  inputs?: Record<string, string>;
  /** Environment overrides merged on top of the persona's `env`. */
  env?: Record<string, string>;
}

export interface SandboxExecArgs {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  output: string;
  exitCode: number;
}

export interface SandboxContext {
  /** Absolute path the runner sees as its working tree. */
  cwd: string;
  exec(cmd: string, opts?: SandboxExecArgs): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface FilesContext {
  /** Read a Relayfile/sandbox-visible file. */
  read(path: string): Promise<string>;
  /** Write a Relayfile/sandbox-visible file. */
  write(path: string, contents: string): Promise<void>;
}

export interface MemorySaveOptions {
  tags?: string[];
  scope?: PersonaMemoryScope;
  /** Optional expiry in seconds from now. */
  ttlSeconds?: number;
  /** Optional expiry in milliseconds from now. */
  expiresInMs?: number;
}

export interface MemoryRecallOptions {
  limit?: number;
  scope?: PersonaMemoryScope;
  scopes?: PersonaMemoryScope[];
  tags?: string[];
}

export interface MemoryItem {
  id: string;
  content: string;
  tags: string[];
  scope: PersonaMemoryScope;
  createdAt: string;
}

export interface MemoryContext {
  save(content: string, opts?: MemorySaveOptions): Promise<{ id: string } | void>;
  recall(query: string, opts?: MemoryRecallOptions): Promise<MemoryItem[]>;
}

export interface WorkflowRunHandle {
  runId: string;
  completion(): Promise<{ output: unknown; status: 'success' | 'failure' }>;
}

export interface WorkflowContext {
  run(name: string, args?: Record<string, unknown>): Promise<WorkflowRunHandle>;
  status(runId: string): Promise<{ status: 'pending' | 'running' | 'success' | 'failure'; output?: unknown; error?: string; patches?: unknown }>;
}

/** Per-member result aggregated from `submit_result` (spec §6.2/§12). */
export interface TeamMemberResult {
  status: string;
  output: string;
  resultId?: string;
}

/** Spawn-call shape for `ctx.team.spawn(...)` (spec §6.1/§6.4). */
export interface TeamSpawnArgs {
  task: string;
  teamPrompt?: string;
  members: Array<{ name: string; persona: string; role?: 'orchestrator' | 'worker' | 'reviewer'; task?: string }>;
  sharedMount?: string;
  ttlSeconds?: number;
  maxMembers?: number;
}

/** `GET …/teams/{teamId}` normalized status payload (spec §6.2). */
export interface TeamStatus {
  teamId: string;
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  members: Array<Record<string, unknown>>;
  results: Record<string, TeamMemberResult>;
  summary: string;
}

/** Terminal team outcome returned by `completion()` (spec §6.4). */
export interface TeamResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  members: Record<string, TeamMemberResult>;
  summary: string;
}

/** Handle over a spawned/attached team (spec §6.4). */
export interface TeamHandle {
  teamId: string;
  channel: string;
  sharedMountRoot: string;
  status(): Promise<TeamStatus>;
  completion(): Promise<TeamResult>;
  cancel(): Promise<void>;
}

/** Cloud team invocation surface, mirroring `ctx.workflow` (spec §6.4). */
export interface TeamContext {
  spawn(args: TeamSpawnArgs): Promise<TeamHandle>;
  attach(teamId: string): Promise<TeamHandle>;
}

export interface ScheduleContext {
  at(when: Date, payload: unknown): Promise<void>;
  cancel(name: string): Promise<void>;
}

/**
 * Minimal LLM context for handlers that want raw inference (without
 * spawning the persona's full harness). Backed by either workforce-billed
 * tokens or the user's connected subscription, per the persona's
 * `useSubscription` flag.
 */
export interface LlmContext {
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

/**
 * Per-integration clients attached to the ctx. All Tier-1 providers
 * (github, linear, slack, notion, jira) ship typed VFS-backed clients;
 * a persona only sees the fields its `integrations` block declared, so
 * cron-only handlers get an undefined field across the board.
 */
export interface IntegrationClients {
  github?: GithubClient;
  linear?: LinearClient;
  slack?: SlackClient;
  notion?: NotionClient;
  jira?: JiraClient;
}

export interface WorkforcePersonaContext extends Omit<PersonaSpec, 'inputs'> {
  /** Resolved input values from the agent row and persona defaults. */
  readonly inputs: Record<string, string>;
  /** Raw persona input declarations for consumers that need metadata/defaults. */
  readonly inputSpecs: Record<string, PersonaInputSpec>;
}

export interface WorkforceAgentContext {
  readonly id: string;
  readonly deployedName: string;
  readonly spawnedByAgentId: string | null;
}

export interface WorkforceDeploymentContext {
  readonly id: string;
  readonly triggerKind: 'inbox' | 'clock' | 'radio';
  readonly parentDeploymentId: string | null;
}

/**
 * The context object handlers receive on every event invocation. Per-
 * integration fields are populated only for providers the persona
 * declared in `integrations`. Cron-only personas get a context with all
 * integration fields undefined.
 */
export interface WorkforceCtx extends IntegrationClients {
  /** Read-only persona metadata plus resolved runtime inputs. */
  readonly persona: WorkforcePersonaContext;
  /** Agent row metadata for the agent handling this event. */
  readonly agent: WorkforceAgentContext;
  /** Deployment row metadata for the trigger that fired this handler. */
  readonly deployment: WorkforceDeploymentContext;
  /** Workspace the agent is deployed into. */
  readonly workspaceId: string;
  /** Logical agent name (defaults to `persona.id`). */
  readonly agentName: string;
  /** Raw inference, billed or subscription-backed per persona config. */
  llm: LlmContext;
  /** Spawn the persona's harness inside the sandbox. */
  harness: {
    run(args: HarnessRunArgs): Promise<HarnessRunResult>;
  };
  /** Sandbox shell + filesystem. */
  sandbox: SandboxContext;
  /** Relayfile/sandbox file helpers for handlers that should not shell out. */
  files: FilesContext;
  /** Persistent memory (no-op when persona.memory is false or unset). */
  memory: MemoryContext;
  /** Cloud workflows invocation (HTTP). */
  workflow: WorkflowContext;
  /**
   * Spawn + coordinate a team of sandboxed agents (spec §6.4). Present only
   * when the handler sandbox has cloud credentials (`WORKFORCE_WORKSPACE_TOKEN`
   * + `WORKFORCE_CLOUD_BASE_URL`); `undefined` otherwise.
   */
  team?: TeamContext;
  /** Schedule one-off follow-up ticks. */
  schedule: ScheduleContext;
  /** Structured logger; every line is forwarded to the gateway. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>) => void;
}

/**
 * Default-export shape from a persona's `onEvent` file. The runtime calls
 * this with a fully-constructed ctx and the discriminated event.
 *
 * Errors thrown from `onEvent` are caught by the runtime, logged, and (per
 * persona `options.onError` defaults) retried with backoff.
 */
export type WorkforceHandler = (ctx: WorkforceCtx, event: WorkforceEvent) => Promise<void> | void;

/**
 * Public type returned by `handler(...)`. Identity at runtime; the wrapper
 * exists for type narrowing + future-proofing (we may add metadata, e.g.
 * declared capabilities, to the returned function later).
 */
export interface WorkforceHandlerExport {
  (ctx: WorkforceCtx, event: WorkforceEvent): Promise<void> | void;
  readonly __workforceHandler: true;
}
