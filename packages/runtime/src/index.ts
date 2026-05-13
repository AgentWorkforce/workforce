// Public DX surface for personas. Authors import `handler` to brand
// their event handler; everything else flows through ctx + event types.

export { handler, isWorkforceHandler } from './handler.js';

export type {
  HarnessRunArgs,
  HarnessRunResult,
  FilesContext,
  IntegrationClients,
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

// Integration clients — Relayfile-VFS-backed. All five Tier-1 providers
// ship typed clients on `WorkforceCtx`. Construct them with
// `IntegrationClientOptions` (mount root + writeback timing) — the
// runtime wires this up automatically when a persona declares the
// matching integration.
export {
  createGithubClient,
  createLinearClient,
  createNotionClient,
  createJiraClient,
  createSlackClient,
  type GithubClient,
  type LinearClient,
  type NotionClient,
  type JiraClient,
  type SlackClient,
  type IntegrationClientOptions,
  type WritebackReceipt,
  type WritebackResult,
  WorkforceIntegrationError,
  draftFile,
  encodeSegment,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  resolveMountRoot,
  writeJsonFile
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
