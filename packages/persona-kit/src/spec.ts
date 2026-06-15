/**
 * Narrow, side-effect-free persona/agent spec VALIDATION surface.
 *
 * This entrypoint exists so server-side consumers that only need to
 * validate a persona or agent spec (e.g. AgentWorkforce Cloud's deploy
 * route, which routes persona validation through
 * `@cloud/core/proactive-runtime/persona-spec.js`) can import the parsers
 * and constants WITHOUT pulling in the orchestration modules the package
 * barrel (`index.ts`) re-exports.
 *
 * The barrel re-exports `./mount.js`, `./execute.js`, `./plan.js`,
 * `./skills.js`, `./skill-runner.js`, `./config-files.js`, etc. Importing
 * the barrel therefore EVALUATES every one of those modules' top-level
 * code — `node:child_process`, `node:fs`, and the deferred
 * `@relayfile/local-mount` → `@parcel/watcher` edge — none of which a pure
 * validation consumer needs. `./spec.js` transitively imports only
 * `./parse.js`, `./constants.js`, and `./types.js`, which have ZERO
 * external runtime dependencies (no `@relayfile/*`, no native bindings,
 * no Node process/fs APIs at module-eval time).
 *
 * Keep this entrypoint in lockstep with the validation-related exports of
 * `./index.js`; it is intentionally a strict subset, never a superset.
 */

// Constants (intents, harnesses, permission modes, …)
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

// Spec types
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
  PersonaInputPicker,
  PersonaInputSpec,
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
  SkillSourceKind,
  WatchEvent,
  WatchRule
} from './types.js';

// Parsers, type guards, and the sidecar resolver
export {
  assertInputName,
  assertSidecarPath,
  deepFreeze,
  INPUT_NAME_RE,
  INTEGRATION_SOURCE_NAME_RE,
  isHarness,
  isIntent,
  isObject,
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
