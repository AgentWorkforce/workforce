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

// Raw gateway envelope contract (the runner's stdin NDJSON line shape, and
// the fixture format for invocation simulation).
export { shimEnvelope, type RawGatewayEnvelope } from './shim.js';

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

// Invocation dry-run / simulation (workforce#186): execute a handler against
// fixture envelopes with side effects recorded-not-executed, emitting
// Cloud-compatible run records (`origin: "local_dry_run"`).
export {
  simulateInvocation,
  createSimulationSubsystems,
  deriveSimulatedRunFailureClass,
  type CapturedLogLine,
  type RecordedSideEffect,
  type SimulateInvocationOptions,
  type SimulatedRunFailureClass,
  type SimulatedRunFailureInput,
  type SimulatedRunRecord,
  type SimulationResult,
  type SimulationSink,
  type SimulationSubsystems,
  type UnsupportedEnvelope
} from './simulate/index.js';

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

// Broker-aware relay MCP resolution. Shared between the cloud harness runner
// (cloud-defaults.ts) and the local CLI (packages/cli). Callers use these to
// resolve pre-registered agent-relay MCP args from the broker binary, falling
// back to the legacy @relaycast/mcp injection when the broker is unavailable.
export {
  claudeMcpConfigHasRelayOverride,
  codexExistingArgs,
  injectClaudeAgentRelayMcpConfig,
  injectCodexSubcommandArgs,
  relayOverrideServerNames,
  resolveAgentRelayBrokerMcpArgs,
  resolveRelayMcpFromEnv,
  type RelayMcpLog
} from './relay-mcp.js';

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
