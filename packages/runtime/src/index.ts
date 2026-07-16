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
  type SingleFileAgentDefinition,
  type WorkforceEventFor,
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
  RelayContext,
  RelaySendResult,
  RelayfileCredentials,
  RequiredRuntimeCredentials,
  SandboxContext,
  SandboxExecArgs,
  SandboxExecResult,
  ScheduleContext,
  WorkflowContext,
  WorkflowRunHandle,
  WorkforceAgentContext,
  WorkforceCtx,
  WorkforceDeploymentContext,
  WorkforceEvent,
  WorkforceHandler,
  WorkforceHandlerExport,
  AgentEvent,
  EventType,
  CronTickEvent,
  RelaycastMessageEvent,
  RelayfileChangeEvent,
  StartupEvent
} from './types.js';

// Relay SDK event type guards, re-exported so persona handlers can narrow
// `event` by type without importing `@agent-relay/events` directly.
export {
  isCronTickEvent,
  isRelaycastMessageEvent,
  isRelayfileChangeEvent,
  isStartupEvent
} from './types.js';

// Cross-version cron compatibility for handlers deployed across the v3/v4
// event-model boundary.
export {
  normalizeCronFire,
  workforceEventType,
  type NormalizedCronFire
} from './cron.js';

// Relay (agent-to-agent) client used by ctx.relay; exported for external ctx
// builders and tests.
export { buildRelayContext, DEFAULT_RELAYCAST_URL } from './relay.js';

// Shared process launcher for one-shot harness commands. Prompts are delivered
// off argv through stdin or a private temporary file according to the spec.
export {
  spawnAndCapture,
  spawnNonInteractiveAndCapture,
  type CapturedProcessResult,
  type SpawnAndCaptureArgs,
  type SpawnNonInteractiveAndCaptureArgs
} from './harness-process.js';

// Runtime envelope helpers shared by provider-triggered agents.
export {
  unwrapResourceRecord
} from './types.js';

// Raw gateway envelope contract (the runner's stdin NDJSON line shape, and
// the fixture format for invocation simulation) + the envelope→AgentEvent decoder.
export { type RawGatewayEnvelope } from './shim.js';
export { envelopeToAgentEvent } from './to-agent-event.js';

// Versioned Agent compiler and Run engine contracts. These are additive to
// the existing simulation record while hosted/local producers migrate.
export {
  LOCAL_EFFECT_POLICY_DEFAULTS,
  mergeAllowedHttpRules,
  resolvePersonaHttpReadRules,
  resolveLocalEffectPolicy,
  type CompiledAgentV1,
  type Diagnostic,
  type EffectPolicyV1,
  type PreviewAction,
  type RunArtifactEntry,
  type RunArtifactManifest,
  type RunMode,
  type RunRecordV2,
  type RunRequestV1,
  type RunTraceEventV1,
  type StateDiff,
  type StateSourceV1
} from './run-contracts.js';
export {
  executeLocalRun,
  type ExecuteLocalRunOptions,
  type ExecuteLocalRunResult,
  type LocalHttpFixture,
  type LocalModelFixture,
  type LocalPreviewMemoryEntry,
  type LocalPreviewState
} from './local-preview.js';

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
  normalizeWritebackStatus,
  type IntegrationClientOptions,
  type NormalizedWritebackState,
  type NormalizedWritebackStatus,
  type WritebackReceipt,
  type WritebackResult,
  WritebackError,
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
