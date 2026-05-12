// Public DX surface for personas. Authors import `handler` to brand
// their event handler; everything else flows through ctx + event types.

export { handler, isWorkforceHandler } from './handler.js';

export type {
  HarnessRunArgs,
  HarnessRunResult,
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
  WorkforceCronEvent,
  WorkforceCtx,
  WorkforceEvent,
  WorkforceEventSource,
  WorkforceHandler,
  WorkforceHandlerExport,
  WorkforceProviderEvent
} from './types.js';

// Integration clients — concrete today: github. Others are typed `unknown`
// in `WorkforceCtx` until they ship; importing them from here keeps
// handler-side imports stable when typed clients land.
export {
  createGithubClient,
  WorkforceIntegrationError,
  isRetryableStatus,
  type GithubClient,
  type GithubClientOptions,
  type GithubIssueRef,
  type GithubIssueTarget,
  type GithubPr,
  type GithubRepoCoords,
  type GithubReview,
  type GithubReviewComment,
  type GithubUpsertResult
} from './clients/index.js';

// Re-export persona-kit types personas commonly reference at the handler
// surface, so users don't need a second import for the shapes the ctx
// carries.
export type {
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaMemoryScope,
  PersonaSchedule,
  PersonaSpec,
  PersonaTier,
  PersonaTraits
} from '@agentworkforce/persona-kit';
