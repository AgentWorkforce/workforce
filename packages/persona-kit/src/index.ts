// Constants
export {
  BUILT_IN_PERSONA_INTENTS,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_SKILL_TARGETS,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  PERSONA_TAGS,
  SIDECAR_MD_MODES,
  SKILL_SOURCE_KINDS
} from './constants.js';
export type { KnownPersonaTag } from './constants.js';

// Types
export type {
  AgentSpec,
  CapabilityValue,
  CodexApprovalPolicy,
  CodexSandboxMode,
  Harness,
  HarnessSettings,
  HarnessSkillTarget,
  IntegrationSource,
  McpServerSpec,
  PermissionMode,
  PersonaContext,
  PersonaInputPicker,
  PersonaInputSpec,
  PersonaInstallContext,
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaIntent,
  PersonaAiMemoryConfig,
  PersonaMemory,
  PersonaMemoryConfig,
  PersonaMemoryScope,
  PersonaRelay,
  PersonaRelayConfig,
  PersonaTrajectoryConfig,
  PersonaMount,
  PersonaPermissions,
  PersonaSchedule,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  ProactiveCapabilities,
  SidecarMdMode,
  SkillInstall,
  SkillMaterializationOptions,
  SkillMaterializationPlan,
  SkillSourceKind,
  WatchEvent,
  WatchRule
} from './types.js';

// Typed persona authoring
export {
  definePersona,
  type AdapterConfigFor,
  type GitHubAdapterConfig,
  type GitHubMaterializationFilter,
  type GitHubMaterializationMode,
  type GitHubMaterializationPolicy,
  type GitHubMaterializationResource,
  type GitHubMaterializationResourcePolicy,
  type GitHubMaterializationRule,
  type PersonaDefinition,
  type ScopeKeysFor,
  type TriggerNameFor,
  type TypedIntegrationConfig,
  type TypedIntegrations,
  type TypedScopeMap,
  type TypedTrigger,
  type TypedTriggerMap
} from './define.js';

// Per-provider connection scope-key catalog (from @relayfile/adapter-core/scope-keys)
export {
  KNOWN_SCOPE_KEY_CATALOG,
  ADAPTERS_WITHOUT_KNOWN_SCOPE_KEYS,
  type ScopeKey,
  type ScopeKeyProvider
} from './scope-keys.js';

// Parsers + sidecar resolver
export {
  assertInputName,
  assertSidecarPath,
  deepFreeze,
  INPUT_NAME_RE,
  INTEGRATION_SOURCE_NAME_RE,
  isHarness,
  isIntent,
  isObject,
  isPlainObject,
  isSidecarMode,
  isTag,
  parseAgentSpec,
  parseCapabilities,
  parseHarnessSettings,
  parseInputs,
  parseIntegrationConfig,
  parseIntegrationSource,
  parseIntegrationTrigger,
  parseIntegrations,
  parseMcpServers,
  parseMemory,
  parseMount,
  parseOnEvent,
  parseRelay,
  parsePermissions,
  parsePersonaSpec,
  resolveAiMemory,
  resolveTrajectoryRecording,
  parseSchedules,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags,
  parseWatch,
  resolveSidecar,
  sidecarSelectionFields
} from './parse.js';

// Trigger registry + lint helper
export {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG,
  KNOWN_TRIGGER_PROVIDER_ALIASES,
  KNOWN_TRIGGERS,
  lintTriggers,
  type KnownProviderName,
  type KnownTriggerName,
  type TriggerLintCode,
  type TriggerLintIssue,
  type TriggerLintLevel
} from './triggers.js';

// Skill materialization
export {
  buildCleanupArtifacts,
  buildInstallArtifacts,
  materializeSkills,
  materializeSkillsFor,
  resolveSkillSource
} from './skills.js';

// Persistent skill-install cache
export {
  computeSkillCacheFingerprint,
  isSkillCacheValid,
  readSkillCacheMarker,
  resolveSkillCacheDir,
  skillCacheRoot,
  updateSkillCacheMarkerUpstream,
  writeSkillCacheMarker,
  type SkillCacheFingerprintInput,
  type SkillCacheMarker,
  type SkillCacheMarkerSkill,
  type SkillUpstreamRecord
} from './skill-cache.js';

// Upstream drift detection (opt-in, TTL-gated)
export {
  buildUpstreamRecordsFromCacheDir,
  detectSkillUpstreamDrift,
  isUpstreamCheckDue,
  parseCheckInterval,
  type ProbeDeps,
  type SkillDriftDetail,
  type UpstreamDriftResult
} from './skill-upstream-probe.js';

// Env-ref resolution
export {
  MissingEnvRefError,
  makeEnvRefResolver,
  makeLenientResolver,
  resolveStringMap,
  resolveStringMapLenient,
  type DroppedRef,
  type EnvRefResolver,
  type LenientResult
} from './env-refs.js';

// MCP resolution
export {
  formatDropWarnings,
  resolveMcpServersLenient,
  type DroppedMcpServer,
  type McpResolution
} from './mcp.js';

// Persona inputs
export {
  MissingPersonaInputError,
  renderPersonaInputs,
  resolvePersonaInputs,
  type PersonaInputResolution,
  type PersonaInputValues
} from './inputs.js';

// Interactive harness spec
export {
  buildInteractiveSpec,
  buildNonInteractiveSpec,
  type AiHistMcpConfig,
  type BuildInteractiveSpecInput,
  type InteractiveConfigFile,
  type InteractiveSpec,
  type NonInteractiveSpec,
  type RelayMcpConfig,
  resolvePersonaRelayMcp,
  type ResolveRelayMcpResult
} from './interactive-spec.js';

// Harness detection
export {
  detectHarness,
  detectHarnesses,
  type HarnessAvailability
} from './detect.js';

// Plan builder + plan types
export {
  buildPersonaSpawnPlan,
  type PersonaSpawnPlan,
  type PlanOptions,
  type ResolvedInputBinding,
  type ResolvedMountPolicy,
  type ResolvedPersona,
  type ResolvedSidecarWrite
} from './plan.js';

// Side-effecting orchestration
export {
  executePersonaSpawnPlan,
  type ExecuteOptions,
  type ExecutionHandle
} from './execute.js';

// Piecewise side-effect helpers (advanced orchestration)
export {
  applyPersonaMount,
  type ApplyPersonaMountOptions,
  type PersonaMountHandle
} from './mount.js';
export {
  writePersonaSidecars,
  type PersonaSidecarHandle
} from './sidecars.js';
export {
  assertSafeRelativePath,
  materializePersonaConfigFiles,
  type PersonaConfigFilesHandle
} from './config-files.js';
export {
  runSkillInstalls,
  SkillInstallError,
  type PersonaSkillsHandle,
  type RunSkillInstallsOptions
} from './skill-runner.js';
