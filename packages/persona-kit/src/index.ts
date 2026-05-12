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

// Types
export type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  Harness,
  HarnessSettings,
  HarnessSkillTarget,
  McpServerSpec,
  PermissionMode,
  PersonaContext,
  PersonaInputSpec,
  PersonaInstallContext,
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaIntent,
  PersonaMemory,
  PersonaMemoryConfig,
  PersonaMemoryScope,
  PersonaMount,
  PersonaPermissions,
  PersonaSandbox,
  PersonaSandboxConfig,
  PersonaSchedule,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  PersonaTraits,
  SidecarMdMode,
  SkillInstall,
  SkillMaterializationOptions,
  SkillMaterializationPlan,
  SkillSourceKind
} from './types.js';

// Parsers + sidecar resolver
export {
  assertInputName,
  assertSidecarPath,
  deepFreeze,
  INPUT_NAME_RE,
  isHarness,
  isIntent,
  isObject,
  isSidecarMode,
  isTag,
  parseHarnessSettings,
  parseInputs,
  parseIntegrationConfig,
  parseIntegrationTrigger,
  parseIntegrations,
  parseMcpServers,
  parseMemory,
  parseMount,
  parseOnEvent,
  parsePermissions,
  parsePersonaSpec,
  parseSandbox,
  parseSchedules,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags,
  parseTraits,
  resolveSidecar,
  sidecarSelectionFields
} from './parse.js';

// Trigger registry + lint helper
export {
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
  type BuildInteractiveSpecInput,
  type InteractiveConfigFile,
  type InteractiveSpec,
  type NonInteractiveSpec
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
