import { buildInteractiveSpec, type InteractiveConfigFile } from './interactive-spec.js';
import { resolvePersonaInputs, renderPersonaInputs } from './inputs.js';
import { materializeSkills } from './skills.js';
import type {
  Harness,
  PersonaInputSpec,
  PersonaMount,
  PersonaSelection,
  SidecarMdMode,
  SkillMaterializationPlan
} from './types.js';

/**
 * Alias of {@link PersonaSelection}. The orchestration API names the
 * fully-resolved persona "ResolvedPersona" because callers think of a
 * spawn plan as "what runs", not "what was selected from the catalog".
 */
export type ResolvedPersona = PersonaSelection;

/**
 * Mount policy resolved against any caller dotfiles / extra patterns.
 * The plan carries this through verbatim; the executor passes it to the
 * mount provider (e.g. {@link import('./mount.js').applyPersonaMount}).
 */
export interface ResolvedMountPolicy {
  ignoredPatterns: string[];
  readonlyPatterns: string[];
}

/**
 * Sidecar markdown the executor must write into the harness cwd. The body
 * is supplied either inline (built-in personas, where the catalog generator
 * already inlined the markdown) or by absolute path (local/pack personas
 * that ship the sidecar as a sibling file). The path form keeps the plan
 * JSON-serializable; the executor reads the file at write time.
 */
export type ResolvedSidecarWrite = {
  /** Filename inside the cwd: `CLAUDE.md` (claude) or `AGENTS.md` (opencode/codex). */
  filename: 'CLAUDE.md' | 'AGENTS.md';
  /**
   * `overwrite` writes verbatim; `extend` appends a `\n\n---\n\n`-joined
   * suffix onto whatever already exists at the destination at execute time.
   */
  mode: SidecarMdMode;
} & (
  | {
      /** Inlined body. */
      contents: string;
      sourcePath?: never;
    }
  | {
      /** Absolute path to read at execute time. */
      sourcePath: string;
      contents?: never;
    }
);

/** Per-input env binding to merge into the spawn env. */
export interface ResolvedInputBinding {
  name: string;
  /** Env-var name to bind under. Falls back to `name` when the spec omits one. */
  envName: string;
  value: string;
}

export interface PersonaSpawnPlan {
  /** The fully resolved persona this plan was built from. */
  persona: ResolvedPersona;
  /** Which CLI to spawn (`claude` | `codex` | `opencode`). */
  cli: Harness;
  /** argv (excluding the cli itself) that the harness should be spawned with. */
  args: string[];
  /** Optional initial prompt — used by codex's argv-driven prompt mode. */
  initialPrompt?: string;
  /** MCP / harness config files to materialize before spawn (and restore after). */
  configFiles: InteractiveConfigFile[];
  /** Pure skills install plan (from {@link materializeSkills}). */
  skills: SkillMaterializationPlan;
  /** Resolved mount policy, or undefined if the persona declares none. */
  mount?: ResolvedMountPolicy;
  /** Sidecar markdown writes (claudeMd / agentsMd) staged for the run. */
  sidecars: ResolvedSidecarWrite[];
  /** Inputs as resolved env bindings, ready to merge into spawn env. */
  inputs: ResolvedInputBinding[];
  /**
   * Final env (process.env merged with input bindings + persona env, with
   * persona env winning on conflict). Always materialized so callers do not
   * need to re-merge by hand.
   */
  env: Record<string, string>;
}

export interface PlanOptions {
  /**
   * Stage skills under this absolute directory instead of the repo's
   * `.claude/skills/`. Claude harness only — throws otherwise (matching the
   * existing {@link materializeSkills} behavior).
   */
  installRoot?: string;
  /** Extra env bindings to merge in. Persona env wins on conflict. */
  envOverrides?: Record<string, string>;
  /**
   * Process env to read input env-var fallbacks from (default: process.env).
   * **Captured into `plan.env`.** The plan is JSON-serializable, so passing
   * `process.env` here will inline ambient values (potentially including
   * secrets) into the serialized plan — set `includeProcessEnv` only when
   * you intend to forward ambient env to the harness, and prefer supplying
   * a curated snapshot via {@link processEnv}.
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Opt in to capturing ambient {@link processEnv} into `plan.env`. Default
   * `false`: when omitted, `plan.env` contains only persona-author env,
   * resolved input bindings, and {@link envOverrides}. When `true` and no
   * explicit {@link processEnv} is supplied, `process.env` is captured.
   */
  includeProcessEnv?: boolean;
  /**
   * Caller-supplied input values (highest precedence over env/default). Same
   * shape as {@link import('./inputs.js').resolvePersonaInputs}'s `provided`.
   */
  inputValues?: Record<string, string | number | boolean | null | undefined>;
}

function resolvedInputBindings(
  inputs: Record<string, PersonaInputSpec> | undefined,
  values: Record<string, string>
): ResolvedInputBinding[] {
  if (!inputs) return [];
  return Object.entries(inputs)
    .filter(([name]) => values[name] !== undefined)
    .map(([name, spec]) => ({
      name,
      envName: spec.env ?? name,
      value: values[name]
    }));
}

function resolveSidecarWrite(
  selection: ResolvedPersona
): ResolvedSidecarWrite[] {
  const harness = selection.harness;
  if (harness === 'claude') {
    if (selection.claudeMdContent !== undefined) {
      return [
        {
          filename: 'CLAUDE.md',
          contents: selection.claudeMdContent,
          mode: selection.claudeMdMode ?? 'overwrite'
        }
      ];
    }
    if (selection.claudeMd) {
      return [
        {
          filename: 'CLAUDE.md',
          sourcePath: selection.claudeMd,
          mode: selection.claudeMdMode ?? 'overwrite'
        }
      ];
    }
    return [];
  }
  if (harness === 'opencode' || harness === 'codex') {
    if (selection.agentsMdContent !== undefined) {
      return [
        {
          filename: 'AGENTS.md',
          contents: selection.agentsMdContent,
          mode: selection.agentsMdMode ?? 'overwrite'
        }
      ];
    }
    if (selection.agentsMd) {
      return [
        {
          filename: 'AGENTS.md',
          sourcePath: selection.agentsMd,
          mode: selection.agentsMdMode ?? 'overwrite'
        }
      ];
    }
    return [];
  }
  return [];
}

function resolveMountPolicy(
  mount: PersonaMount | undefined
): ResolvedMountPolicy | undefined {
  if (!mount) return undefined;
  if (mount.enabled === false) return undefined;
  const ignored = mount.ignoredPatterns ?? [];
  const readonly = mount.readonlyPatterns ?? [];
  if (ignored.length === 0 && readonly.length === 0) return undefined;
  return {
    ignoredPatterns: [...ignored],
    readonlyPatterns: [...readonly]
  };
}

/**
 * Pure plan builder. Composes existing persona-kit helpers
 * ({@link buildInteractiveSpec}, {@link materializeSkills},
 * {@link resolvePersonaInputs}) into a single inspectable
 * {@link PersonaSpawnPlan}. Does **no** filesystem writes and spawns no
 * subprocesses.
 *
 * The returned plan is JSON-serializable: every field is a plain value or
 * primitive array. Callers can stamp it into launch metadata, send it across
 * a wire, or hand it to {@link import('./execute.js').executePersonaSpawnPlan}.
 */
export function buildPersonaSpawnPlan(
  persona: ResolvedPersona,
  options: PlanOptions = {}
): PersonaSpawnPlan {
  const harness = persona.harness;
  // Input env-var fallbacks read from `processEnv` only when ambient capture
  // is opted into. With ambient capture off, `resolvePersonaInputs` sees an
  // empty env and inputs must resolve from explicit values, persona
  // `inputValues`, or `default` — keeping plans deterministic across hosts.
  const processEnv: NodeJS.ProcessEnv =
    options.processEnv ?? (options.includeProcessEnv ? process.env : {});
  const inputResolution = resolvePersonaInputs(
    persona.inputs ?? persona.inputValues
      ? persona.inputs ?? undefined
      : undefined,
    options.inputValues ?? persona.inputValues,
    processEnv
  );
  const renderedSystemPrompt = renderPersonaInputs(
    persona.systemPrompt,
    inputResolution.values
  );
  const skills = materializeSkills(
    persona.skills,
    harness,
    options.installRoot !== undefined ? { installRoot: options.installRoot } : {}
  );

  const spec = buildInteractiveSpec({
    harness,
    personaId: persona.personaId,
    model: persona.model,
    systemPrompt: renderedSystemPrompt,
    ...(persona.mcpServers ? { mcpServers: persona.mcpServers } : {}),
    ...(persona.permissions ? { permissions: persona.permissions } : {}),
    ...(persona.harnessSettings
      ? { harnessSettings: persona.harnessSettings }
      : {}),
    ...(skills.sessionInstallRoot
      ? { pluginDirs: [skills.sessionInstallRoot] }
      : {})
  });

  const inputBindings = resolvedInputBindings(persona.inputs, inputResolution.values);
  const sidecars = resolveSidecarWrite(persona);
  const mount = resolveMountPolicy(persona.mount);

  // Env precedence (later wins):
  //   ambient processEnv (opt-in)
  //   → resolved input bindings
  //   → caller envOverrides
  //   → persona-author env
  //
  // Ambient capture is opt-in to keep secrets out of the JSON-serializable
  // plan by default — callers must pass `includeProcessEnv: true` (or supply
  // a curated `processEnv` snapshot) to forward ambient values.
  const env: Record<string, string> = {};
  const ambientSource =
    options.processEnv ?? (options.includeProcessEnv ? process.env : undefined);
  if (ambientSource) {
    for (const [k, v] of Object.entries(ambientSource)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  for (const binding of inputBindings) env[binding.envName] = binding.value;
  if (options.envOverrides) Object.assign(env, options.envOverrides);
  if (persona.env) Object.assign(env, persona.env);

  const plan: PersonaSpawnPlan = {
    persona,
    cli: harness,
    args: [...spec.args],
    configFiles: spec.configFiles.map((f) => ({ path: f.path, contents: f.contents })),
    skills,
    sidecars,
    inputs: inputBindings,
    env,
    ...(spec.initialPrompt !== null ? { initialPrompt: spec.initialPrompt } : {}),
    ...(mount ? { mount } : {})
  };
  return plan;
}
