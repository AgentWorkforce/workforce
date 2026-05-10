// harness-kit's surface is persona-shaped. The canonical implementations live
// in @agentworkforce/persona-kit; this file is a re-export shim until 6/8
// removes harness-kit entirely. The runner functions (useRunnablePersona,
// makeRunnablePersonaContext, etc.) bridge persona-kit + workload-router and
// stay co-located here for now to avoid a workspace dep cycle between
// persona-kit and workload-router.

export {
  MissingEnvRefError,
  makeEnvRefResolver,
  makeLenientResolver,
  resolveStringMap,
  resolveStringMapLenient,
  type DroppedRef,
  type EnvRefResolver,
  type LenientResult
} from '@agentworkforce/persona-kit';

export {
  formatDropWarnings,
  resolveMcpServersLenient,
  type DroppedMcpServer,
  type McpResolution
} from '@agentworkforce/persona-kit';

export {
  MissingPersonaInputError,
  renderPersonaInputs,
  resolvePersonaInputs,
  type PersonaInputResolution,
  type PersonaInputValues
} from '@agentworkforce/persona-kit';

export {
  buildInteractiveSpec,
  type BuildInteractiveSpecInput,
  type InteractiveConfigFile,
  type InteractiveSpec
} from '@agentworkforce/persona-kit';

export {
  detectHarness,
  detectHarnesses,
  type HarnessAvailability
} from '@agentworkforce/persona-kit';

export {
  buildNonInteractiveSpec,
  makeRunnablePersonaContext,
  useRunnablePersona,
  useRunnableSelection,
  type NonInteractiveSpec,
  type PersonaExecution,
  type PersonaExecutionResult,
  type PersonaSendOptions,
  type RunnablePersonaContext,
  type RunnablePersonaOptions,
  type RunnableSelectionOptions
} from './runner.js';
