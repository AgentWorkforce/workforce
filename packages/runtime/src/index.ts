// Public DX surface for personas. Authors import `handler` to brand
// their event handler; everything else flows through ctx + event types.

export { handler, isWorkforceHandler } from './handler.js';

export type {
  HarnessRunArgs,
  HarnessRunResult,
  FilesContext,
  LlmContext,
  MemoryContext,
  MemoryItem,
  MemoryRecallOptions,
  MemorySaveOptions,
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
  WorkforceIntegrationError,
  SandboxNotAvailableError
} from './clients/index.js';

// Re-export persona-kit types personas commonly reference at the handler
// surface, so users don't need a second import for the shapes the ctx
// carries.
export type {
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaMemoryScope,
  PersonaSchedule,
  PersonaSpec
} from '@agentworkforce/persona-kit';
