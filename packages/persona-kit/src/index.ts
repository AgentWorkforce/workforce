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
  PERSONA_TIERS,
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
  PersonaIntent,
  PersonaMount,
  PersonaPermissions,
  PersonaRuntime,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  PersonaTier,
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
  isTier,
  parseHarnessSettings,
  parseInputs,
  parseMcpServers,
  parseMount,
  parsePermissions,
  parsePersonaSpec,
  parseRuntime,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags,
  resolveSidecar,
  sidecarSelectionFields
} from './parse.js';

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
  type BuildInteractiveSpecInput,
  type InteractiveConfigFile,
  type InteractiveSpec
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
