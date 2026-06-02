// Public DX surface for personas. Authors import `handler` to brand
// their event handler; everything else flows through ctx + event types.

export { handler, isWorkforceHandler } from './handler.js';

// Typed agent authoring. `defineAgent` is the agent.ts default export — it
// declares the agent's triggers/schedules/watch and handler, with the handler
// `event` narrowed to the declared triggers.
export {
  defineAgent,
  isWorkforceAgent,
  type AgentDefinition,
  type AgentEvent,
  type WorkforceAgentExport
} from './define-agent.js';

export type {
  HarnessRunArgs,
  HarnessRunResult,
  CloudApiCredentials,
  CredentialsContext,
  FilesContext,
  LlmContext,
  MemoryContext,
  MemoryItem,
  MemoryRecallOptions,
  MemorySaveOptions,
  RelayfileCredentials,
  RequiredRuntimeCredentials,
  SandboxContext,
  SandboxExecArgs,
  SandboxExecResult,
  ScheduleContext,
  WorkflowContext,
  WorkflowRunHandle,
  WorkforceAgentContext,
  WorkforceCronEvent,
  WorkforceCtx,
  WorkforceDeploymentContext,
  WorkforceEvent,
  WorkforceEventSource,
  WorkforceHandler,
  WorkforceHandlerExport,
  WorkforceProviderEvent
} from './types.js';

// Runtime envelope helpers shared by provider-triggered agents.
export {
  unwrapResourceRecord
} from './types.js';

export type {
  LinearAgentActivity,
  LinearAgentActivityType,
  LinearAgentSession,
  LinearAgentSessionEvent,
  LinearAgentSessionEventPayload,
  LinearAgentSessionPayload,
  LinearAppUserNotificationEventPayload,
  LinearAppUserNotificationPayload,
  LinearIssueReference
} from './types.js';

// VFS-backed transport helpers. All provider interactions go through these
// — no per-provider client code in the runtime. Handlers use listJsonFiles /
// readJsonFile / writeJsonFile directly against the provider path conventions
// (e.g. /linear/issues, /slack/channels).
export {
  draftFile,
  encodeSegment,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions,
  type WritebackReceipt,
  type WritebackResult,
  RelayfileWritebackError,
  type RelayfileWritebackErrorOptions,
  WorkforceIntegrationError,
  type WorkforceIntegrationErrorOptions,
  SandboxNotAvailableError
} from './clients/index.js';

// Re-export persona-kit types personas commonly reference at the handler
// surface, so users don't need a second import for the shapes the ctx
// carries.
export type {
  AgentSpec,
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaMemoryScope,
  PersonaSchedule,
  PersonaSpec,
  TypedTriggerMap,
  WatchRule
} from '@agentworkforce/persona-kit';
