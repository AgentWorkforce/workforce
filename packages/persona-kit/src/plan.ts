import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

import { makeEnvRefResolver } from './env-refs.js';
import {
  buildInteractiveSpec,
  type AiHistMcpConfig,
  type InteractiveConfigFile
} from './interactive-spec.js';
import { resolvePersonaInputs, renderPersonaInputs } from './inputs.js';
import { resolveAiMemory } from './parse.js';
import { materializeSkills } from './skills.js';
import type {
  Harness,
  PersonaInputSpec,
  PersonaMount,
  PersonaMountRoot,
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
 * A single resolved mount root inside a multi-root {@link ResolvedMountPolicy}.
 * Path is already absolute (env-refs expanded, `~` expanded) and ready to
 * hand to relayfile's `createMount`. Patterns are per-root extensions to the
 * policy-level lists — the executor concatenates them before calling
 * `createMount` for each root.
 */
export interface ResolvedMountRoot {
  alias: string;
  /** Absolute path on disk. Optional roots that resolved to a missing path are dropped before reaching this list. */
  path: string;
  readonly: boolean;
  ignoredPatterns: string[];
  readonlyPatterns: string[];
}

/**
 * Mount policy resolved against any caller dotfiles / extra patterns.
 * The plan carries this through verbatim; the executor passes it to the
 * mount provider (e.g. {@link import('./mount.js').applyPersonaMount}).
 *
 * `roots` is set only when the persona opts into multi-root mounts. When
 * absent, the legacy single-root cwd mount path applies.
 */
export interface ResolvedMountPolicy {
  ignoredPatterns: string[];
  readonlyPatterns: string[];
  roots?: ResolvedMountRoot[];
}

/**
 * Sidecar markdown the executor must write into the harness cwd. The body
 * is supplied either inline (built-in personas, where the catalog generator
 * already inlined the markdown) or by absolute path (local/pack personas
 * that ship the sidecar as a sibling file). The path form keeps the plan
 * JSON-serializable; the executor reads the file at write time.
 */
export type ResolvedSidecarWrite = {
  /** Filename inside the cwd: `CLAUDE.md` (claude) or `AGENTS.md` (opencode/codex/grok/cursor). */
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
  /** Which binary to spawn (`claude` | `codex` | `opencode` | `grok` | `cursor-agent`). */
  cli: string;
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

function resolveAiHistConfig(env: NodeJS.ProcessEnv, dbPathOverride?: string): AiHistMcpConfig {
  const trajectoryRoot = env.TRAJECTORY_ROOT?.trim();
  const dbPath = dbPathOverride?.trim() || env.AI_HIST_DB?.trim();
  return {
    ...(trajectoryRoot ? { trajectoryRoot } : {}),
    ...(dbPath ? { dbPath } : {})
  };
}

/**
 * Env used to expand `mount.roots[].path`. Declared inputs are visible under
 * both their name (prompt templates and the interactive CLI) and their `env`
 * name (what {@link buildPersonaSpawnPlan} injects into the harness).
 * Precedence matches the spawn plan: ambient process env, then those input
 * bindings, then `envOverrides`, then persona `env`.
 *
 * An input name is not written when it is another input's `env` name.
 * `FIRST.env = SECOND` and an input named `SECOND` would otherwise replace
 * the harness binding, so `$SECOND` would mount the wrong repo.
 */
export function buildMountResolutionEnv(options: {
  processEnv?: NodeJS.ProcessEnv;
  inputs?: Record<string, PersonaInputSpec>;
  inputValues?: Record<string, string>;
  envOverrides?: Record<string, string>;
  personaEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (options.processEnv) {
    for (const [key, value] of Object.entries(options.processEnv)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  const inputValues = options.inputValues ?? {};
  const inputs = options.inputs ?? {};
  const envNames = new Set(
    Object.entries(inputs).map(([name, spec]) => spec.env ?? name)
  );
  for (const [name, spec] of Object.entries(inputs)) {
    const value = inputValues[name];
    if (value === undefined) continue;
    env[spec.env ?? name] = value;
  }
  for (const [name, spec] of Object.entries(inputs)) {
    const value = inputValues[name];
    if (value === undefined) continue;
    const envName = spec.env ?? name;
    if (name !== envName && !envNames.has(name)) env[name] = value;
  }
  if (options.envOverrides) Object.assign(env, options.envOverrides);
  if (options.personaEnv) Object.assign(env, options.personaEnv);
  return env;
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
  if (harness === 'opencode' || harness === 'codex' || harness === 'grok' || harness === 'cursor') {
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

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return `${homedir()}/${path.slice(2)}`;
  }
  return path;
}

/**
 * Resolve a single declared root: substitute `$VAR` / `${VAR}` against the
 * supplied env, expand `~`, and require the result to be absolute. When the
 * root is optional, missing env refs and missing paths are reported as a
 * `skipped` result rather than thrown; the executor will drop them silently.
 */
function resolveMountRoot(
  root: PersonaMountRoot,
  processEnv: NodeJS.ProcessEnv,
  context: string
): { kind: 'ok'; root: ResolvedMountRoot } | { kind: 'skip'; reason: string } {
  const resolve = makeEnvRefResolver(processEnv);
  let expanded: string;
  try {
    expanded = resolve(root.path, `${context}.path`);
  } catch (err) {
    if (root.optional) {
      return { kind: 'skip', reason: (err as Error).message };
    }
    throw err;
  }
  const withHome = expandHome(expanded);
  if (!withHome.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(withHome)) {
    const message = `${context}.path resolved to "${withHome}" which is not an absolute path`;
    if (root.optional) return { kind: 'skip', reason: message };
    throw new Error(message);
  }
  if (!existsSync(withHome)) {
    const message = `${context}.path resolved to "${withHome}" but does not exist on disk`;
    if (root.optional) return { kind: 'skip', reason: message };
    throw new Error(message);
  }
  const readonly = root.readonly === true;
  // Convert `readonly: true` into the gitignore-style "**" pattern relayfile
  // understands. Append it after the author's patterns: gitignore last-match
  // wins, so a leading "**" would let a later "!file" negation reopen writes.
  const readonlyPatterns = [
    ...(root.readonlyPatterns ?? []),
    ...(readonly ? ['**'] : [])
  ];
  let canonical: string;
  try {
    canonical = realpathSync(withHome);
  } catch (err) {
    const message = `${context}.path resolved to "${withHome}" but could not be canonicalized: ${(err as Error).message}`;
    if (root.optional) return { kind: 'skip', reason: message };
    throw new Error(message);
  }
  return {
    kind: 'ok',
    root: {
      alias: root.alias,
      path: canonical,
      readonly,
      ignoredPatterns: [...(root.ignoredPatterns ?? [])],
      readonlyPatterns
    }
  };
}

/**
 * Resolve a {@link PersonaMount}'s `roots` against the supplied env: expand
 * `$VAR` / `${VAR}` references, expand leading `~`, drop optional roots whose
 * path is missing, and reject duplicate destinations. Exposed for callers
 * that manage their own relayfile lifecycle (e.g. the CLI's spinner/SIGINT/
 * autosync stack) and need the same resolved layout the executor would use.
 *
 * Returns `undefined` when the persona declared no `roots` (i.e. legacy
 * single-root cwd mount applies) or when every root was optional and
 * unresolvable; an empty array is never returned.
 */
export function resolveMountRoots(
  mount: PersonaMount | undefined,
  processEnv: NodeJS.ProcessEnv,
  context = 'mount'
): ResolvedMountRoot[] | undefined {
  if (!mount?.roots || mount.roots.length === 0) return undefined;
  const out: ResolvedMountRoot[] = [];
  const seen = new Set<string>();
  mount.roots.forEach((root, idx) => {
    const result = resolveMountRoot(root, processEnv, `${context}.roots[${idx}]`);
    if (result.kind === 'skip') return;
    // `path` is realpath'd, so `/repo`, `/repo/`, and a symlink to `/repo`
    // collapse to one mount instead of two write-back watchers.
    if (seen.has(result.root.path)) {
      throw new Error(
        `${context}.roots[${idx}].path resolves to "${result.root.path}" which is already used by another root`
      );
    }
    seen.add(result.root.path);
    out.push(result.root);
  });
  return out.length > 0 ? out : undefined;
}

function resolveMountPolicy(
  mount: PersonaMount | undefined,
  processEnv: NodeJS.ProcessEnv,
  context: string
): ResolvedMountPolicy | undefined {
  if (!mount) return undefined;
  if (mount.enabled === false) return undefined;
  const ignored = mount.ignoredPatterns ?? [];
  const readonly = mount.readonlyPatterns ?? [];
  // resolveMountRoots returns undefined when (a) no roots declared, or (b)
  // every declared root was optional and unresolvable. In case (b) we fall
  // back to the no-mount path (returning undefined here), since multi-root
  // personas inherently have no useful "single cwd" fallback.
  const resolvedRoots = mount.roots && mount.roots.length > 0
    ? resolveMountRoots(mount, processEnv, context)
    : undefined;
  if (mount.roots && mount.roots.length > 0 && !resolvedRoots) {
    return undefined;
  }

  if (ignored.length === 0 && readonly.length === 0 && !resolvedRoots) {
    return undefined;
  }
  return {
    ignoredPatterns: [...ignored],
    readonlyPatterns: [...readonly],
    ...(resolvedRoots ? { roots: resolvedRoots } : {})
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
  const aiMemory = resolveAiMemory(persona.memory);
  const aiHist = aiMemory.enabled ? resolveAiHistConfig(processEnv, aiMemory.dbPath) : false;
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
    ...(aiHist ? { aiHist } : {}),
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
  // Same precedence as `plan.env` below, plus each input's own name so
  // `$REPO` and `$REPO_DIR` both resolve when `inputs.REPO.env` is `REPO_DIR`.
  const mountEnv = buildMountResolutionEnv({
    processEnv: options.processEnv ?? (options.includeProcessEnv ? process.env : undefined),
    inputs: persona.inputs,
    inputValues: inputResolution.values,
    envOverrides: options.envOverrides,
    personaEnv: persona.env
  });
  const mount = resolveMountPolicy(persona.mount, mountEnv, 'mount');

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
    cli: spec.bin,
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
