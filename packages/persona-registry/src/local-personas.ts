import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  SIDECAR_MD_MODES,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type Harness,
  type HarnessSettings,
  type McpServerSpec,
  type PersonaInputSpec,
  type PersonaMount,
  type PersonaPermissions,
  type PersonaSkill,
  type PersonaSpec,
  type PersonaTag,
  type SidecarMdMode,
  parseHarnessSettings,
  parseInputs,
  parseOnEvent
} from '@agentworkforce/persona-kit';
import { listBuiltInPersonas, personaCatalog } from '@agentworkforce/workload-router';

/**
 * User-defined persona override. Local files are partial overlays — only the
 * fields you specify replace the inherited base; everything else cascades down
 * through cwd → configured persona dirs → library.
 *
 * `extends` names the base explicitly by id or intent. If omitted and the file
 * has no `intent`, the loader implicitly inherits from the same-id persona
 * found in the next lower layer. Files with `intent` are standalone personas.
 */
export interface LocalPersonaOverride {
  id: string;
  extends?: string;
  /**
   * When present without `extends`, the file is a complete standalone
   * persona instead of an overlay inheriting from a lower cascade layer.
   */
  intent?: string;
  /**
   * Classification tags. When provided, replaces the inherited base's tags
   * entirely (matching the replace-wholesale semantics used for `skills`).
   */
  tags?: PersonaTag[];
  description?: string;
  skills?: PersonaSpec['skills'];
  inputs?: Record<string, PersonaInputSpec>;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Relayfile mount policy. Pattern lists append to the inherited base so
   * gitignore negations in the overlay can intentionally narrow/reopen scope.
   */
  mount?: PersonaMount;
  /**
   * Permission policy. `allow` and `deny` append to the base's lists (dedup
   * on merge); `mode` replaces the base's mode when set.
   */
  permissions?: PersonaPermissions;
  /** Replaces the inherited systemPrompt when set. */
  systemPrompt?: string;
  /**
   * Handler entry, relative to this file's directory. Its presence marks the
   * persona as a cloud agent: the handler drives the run, so the interactive
   * fields an operator-launched persona must declare are optional here.
   */
  onEvent?: string;
  /** Deployable as a managed cloud agent. */
  cloud?: boolean;
  /** Replaces the inherited harness when set. */
  harness?: Harness;
  /** Replaces the inherited model when set. */
  model?: string;
  /** Per-field harness settings override; merged on top of the inherited harnessSettings. */
  harnessSettings?: Partial<HarnessSettings>;
  /**
   * Path to a `CLAUDE.md` sidecar, relative to this JSON file's directory.
   * The loader stats the file and resolves it to an absolute path on the
   * merged spec; missing files surface as load warnings rather than throws.
   */
  claudeMd?: string;
  claudeMdMode?: SidecarMdMode;
  agentsMd?: string;
  agentsMdMode?: SidecarMdMode;
  claudeMdContent?: string;
  agentsMdContent?: string;
  /** @internal — directory of the JSON file that declared this override. */
  __sourceDir?: string;
}

export type PersonaSource = string;

/**
 * Map an internal {@link PersonaSource} cascade label to the human-readable
 * vocabulary surfaced in `agentworkforce list`, `sources list`, and the
 * interactive picker:
 *
 *   - `library`  → `built-in` — bundled with `@agentworkforce/cli`,
 *                  available to every user without an install step.
 *   - `user`     → `personal` — `~/.agentworkforce/workforce/personas/`,
 *                  i.e. personas a single user keeps across all repos.
 *   - `cwd`      → `cwd`      — `<cwd>/.agentworkforce/workforce/personas/`,
 *                  the working-tree dir; both installed library packs and
 *                  hand-authored team overrides live here. Kept as-is
 *                  because it's a precise pointer to a real directory.
 *   - `cwd:agents` → same — `<cwd>/.agentworkforce/workforce/agents/<name>/persona.json`,
 *                  agents that keep their persona next to their handler.
 *                  Also a precise pointer, so also kept as-is.
 *   - `dir:N`    → `dir:N`    — extra configurable persona dirs (passed
 *                  through unchanged so position is still legible).
 *
 * Internal strings are left alone so `--save-in-directory <target>` and the
 * JSON outputs of `list` / `sources list` keep their existing values.
 */
export function formatPersonaSourceLabel(source: PersonaSource): string {
  if (source === 'library') return 'built-in';
  if (source === 'user') return 'personal';
  return source;
}

interface SourceLayer {
  key: string;
  source: PersonaSource;
  dir: string;
  /** When set, this priority layer loads only the explicitly selected file. */
  file?: string;
  /**
   * One persona per subdirectory (`<dir>/<name>/persona.json`) instead of one
   * per file. See {@link PersonaSourceDirectory.nested}.
   */
  nested?: boolean;
}

export interface PersonaSourceDirectory {
  source: PersonaSource;
  dir: string;
  configurable: boolean;
  /**
   * The directory holds one persona per subdirectory — `<dir>/<name>/persona.json`
   * — rather than one persona per top-level `.json`. Each persona resolves its
   * relative skill and sidecar paths against its own subdirectory, so an agent
   * that ships alongside its handler keeps pointing at its neighboring files.
   */
  nested?: boolean;
}

export interface PersonaSourceConfig {
  configPath: string;
  personaDirs: string[];
  defaultCreateTarget?: string;
  userPersonaDir: string;
  warnings: string[];
}

export interface LoadedLocalPersonas {
  /** Final resolved specs by id, with the cascade applied (higher source dirs win). */
  byId: Map<string, PersonaSpec>;
  /** Where each id in `byId` was defined (top-most layer that declared it). */
  sources: Map<string, PersonaSource>;
  /**
   * Absolute path to the JSON file that produced each id in `byId`. Comes
   * from the topmost layer that declared the id (the same layer
   * `sources` records). Mutating tools — e.g. the post-session
   * persona-improver flow — apply accepted patches at this path.
   */
  paths: Map<string, string>;
  warnings: string[];
}

export interface LoadOptions {
  cwd?: string;
  /** Exact persona JSON file to prepend as the highest registry layer. */
  personaPath?: string;
  /**
   * Back-compat alias for userPersonaDir. Historically local personas lived
   * directly in this directory.
   */
  homeDir?: string;
  userPersonaDir?: string;
  workforceHomeDir?: string;
  configPath?: string;
  /** Full ordered list of configurable persona dirs after cwd and before library. */
  personaDirs?: string[];
  /** Override target used by `agentworkforce create` when set. Defaults to `cwd`. */
  defaultCreateTarget?: string;
}

export function defaultWorkforceHomeDir(): string {
  const override = process.env.AGENT_WORKFORCE_HOME?.trim();
  if (override) return override;
  return join(homedir(), '.agentworkforce', 'workforce');
}

export function defaultUserPersonaDir(workforceHomeDir = defaultWorkforceHomeDir()): string {
  const legacyOverride = process.env.AGENT_WORKFORCE_CONFIG_DIR?.trim();
  if (legacyOverride) return legacyOverride;
  return join(workforceHomeDir, 'personas');
}

export function defaultPersonaConfigPath(workforceHomeDir = defaultWorkforceHomeDir()): string {
  return join(workforceHomeDir, 'config.json');
}

export function defaultCwdPersonaDir(cwd: string): string {
  return join(cwd, '.agentworkforce', 'workforce', 'personas');
}

/**
 * Working-tree directory holding one agent per subdirectory. An agent that
 * ships its own handler keeps persona, handler, tests, and README together in
 * `<cwd>/.agentworkforce/workforce/agents/<name>/`, so its persona is
 * `<name>/persona.json` rather than a loose file under `personas/`.
 */
export function defaultCwdAgentDir(cwd: string): string {
  return join(cwd, '.agentworkforce', 'workforce', 'agents');
}

/** Persona filename read from each subdirectory of a nested source dir. */
export const NESTED_PERSONA_FILENAME = 'persona.json';

/**
 * Authoring source compiled into {@link NESTED_PERSONA_FILENAME}. Present
 * without its compiled sibling, it means the agent was never compiled — the
 * loader is synchronous and cannot bundle TypeScript, so it warns instead.
 */
const NESTED_PERSONA_SOURCE_FILENAMES = ['persona.ts', 'persona.js', 'persona.mjs'];

export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

export function normalizePersonaDir(input: string, baseDir = process.cwd()): string {
  const expanded = expandHomePath(input.trim());
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(baseDir, expanded);
}

interface RawPersonaSourceConfig {
  personaDirs?: string[];
  defaultCreateTarget?: string;
}

function readRawPersonaSourceConfig(
  path: string,
  warnings: string[]
): RawPersonaSourceConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isPlainObject(parsed)) {
      warnings.push(`[config] ${path}: must be a JSON object`);
      return undefined;
    }
    const dirs = parsed.personaDirs;
    let personaDirs: string[] | undefined;
    if (
      dirs !== undefined &&
      (!Array.isArray(dirs) ||
        dirs.some((dir) => typeof dir !== 'string' || !dir.trim()))
    ) {
      warnings.push(`[config] ${path}: personaDirs must be an array of non-empty strings`);
    } else if (dirs !== undefined) {
      personaDirs = dirs.map((dir) => normalizePersonaDir(dir, dirname(path)));
    }
    const defaultCreateTarget = parsed.defaultCreateTarget;
    if (
      defaultCreateTarget !== undefined &&
      (typeof defaultCreateTarget !== 'string' || !defaultCreateTarget.trim())
    ) {
      warnings.push(`[config] ${path}: defaultCreateTarget must be a non-empty string if provided`);
      return personaDirs ? { personaDirs } : {};
    }
    return {
      ...(personaDirs ? { personaDirs } : {}),
      ...(typeof defaultCreateTarget === 'string' ? { defaultCreateTarget: defaultCreateTarget.trim() } : {})
    };
  } catch (err) {
    warnings.push(`[config] ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

function dedupeDirs(dirs: readonly string[], warnings: string[], baseDir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const normalized = normalizePersonaDir(dir, baseDir);
    if (seen.has(normalized)) {
      warnings.push(`[config] duplicate persona source directory ${normalized}; keeping first.`);
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function loadPersonaSourceConfig(options: LoadOptions = {}): PersonaSourceConfig {
  const workforceHomeDir = options.workforceHomeDir ?? defaultWorkforceHomeDir();
  const baseDir = options.cwd ?? process.cwd();
  const userPersonaDir = normalizePersonaDir(
    options.userPersonaDir ?? options.homeDir ?? defaultUserPersonaDir(workforceHomeDir),
    baseDir
  );
  const configPath = normalizePersonaDir(
    options.configPath ?? defaultPersonaConfigPath(workforceHomeDir)
  );
  const warnings: string[] = [];
  const rawConfig = readRawPersonaSourceConfig(configPath, warnings);
  // An explicit legacy/user directory is itself a caller-supplied source
  // configuration unless the caller also explicitly selected a config scope.
  // Do not silently replace it with an unrelated ambient personal config file
  // (tests, embedders, and fleet nodes use this to isolate registry lookup).
  const explicitConfigScope =
    options.configPath !== undefined || options.workforceHomeDir !== undefined;
  const explicitUserScope =
    options.userPersonaDir !== undefined ||
    options.homeDir !== undefined;
  const configuredDirs =
    options.personaDirs ??
    (explicitConfigScope
      ? rawConfig?.personaDirs ?? [userPersonaDir]
      : explicitUserScope
        ? [userPersonaDir]
        : rawConfig?.personaDirs ?? [userPersonaDir]);
  const defaultCreateTarget = options.defaultCreateTarget ?? rawConfig?.defaultCreateTarget;

  return {
    configPath,
    personaDirs: dedupeDirs(configuredDirs, warnings, baseDir),
    ...(defaultCreateTarget ? { defaultCreateTarget } : {}),
    userPersonaDir,
    warnings
  };
}

export function savePersonaSourceConfig(
  personaDirs: readonly string[],
  options: LoadOptions = {}
): PersonaSourceConfig {
  const config = loadPersonaSourceConfig({ ...options, personaDirs: [...personaDirs] });
  mkdirSync(dirname(config.configPath), { recursive: true });
  const serialized = {
    personaDirs: config.personaDirs,
    ...(config.defaultCreateTarget ? { defaultCreateTarget: config.defaultCreateTarget } : {})
  };
  writeFileSync(
    config.configPath,
    JSON.stringify(serialized, null, 2) + '\n',
    'utf8'
  );
  return config;
}

function sourceForPersonaDir(
  dir: string,
  idx: number,
  userPersonaDir: string
): PersonaSource {
  return dir === userPersonaDir ? 'user' : `dir:${idx + 1}`;
}

export function buildPersonaSourceDirectories(
  options: LoadOptions = {}
): { directories: PersonaSourceDirectory[]; config: PersonaSourceConfig } {
  const cwd = options.cwd ?? process.cwd();
  const config = loadPersonaSourceConfig(options);
  const directories: PersonaSourceDirectory[] = [
    {
      source: 'cwd',
      dir: defaultCwdPersonaDir(cwd),
      configurable: false
    },
    // Ranked below `personas/` so a loose override there can still overlay an
    // agent that ships its own persona.
    {
      source: 'cwd:agents',
      dir: defaultCwdAgentDir(cwd),
      configurable: false,
      nested: true
    },
    ...config.personaDirs.map((dir, idx) => ({
      source: sourceForPersonaDir(dir, idx, config.userPersonaDir),
      dir,
      configurable: true
    }))
  ];
  return { directories, config };
}

/** One persona file to read, with the directory its relative paths resolve against. */
interface LayerEntry {
  /** Path relative to the layer dir, used in warnings. */
  label: string;
  path: string;
  sourceDir: string;
}

/**
 * List the persona files a nested layer contributes: `<dir>/<name>/persona.json`
 * for every subdirectory that has one. A subdirectory carrying only the
 * authoring source is reported rather than skipped silently — that is an agent
 * whose `persona.json` was never compiled, which otherwise looks identical to
 * one that does not exist.
 */
function readNestedLayerEntries(
  dir: string,
  layer: SourceLayer,
  warnings: string[]
): LayerEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    warnings.push(`[${layer.source}] could not read ${dir}: ${(err as Error).message}`);
    return [];
  }

  const entries: LayerEntry[] = [];
  for (const name of names) {
    const sourceDir = join(dir, name);
    const path = join(sourceDir, NESTED_PERSONA_FILENAME);
    // Compare against the NEWEST authoring file, not the first one that
    // exists: a directory that still carries an old persona.ts after moving to
    // persona.js would otherwise be measured against the file nobody edits.
    const authoredCandidate = NESTED_PERSONA_SOURCE_FILENAMES.map((file) => ({
      file: join(sourceDir, file),
      mtimeMs: fileMtimeMs(join(sourceDir, file))
    }))
      .filter((candidate): candidate is { file: string; mtimeMs: number } => candidate.mtimeMs !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    const authored = authoredCandidate?.file;
    const compiledAt = fileMtimeMs(path);

    if (compiledAt === undefined) {
      if (authored) {
        warnings.push(
          `[${layer.source}] ${name}: ${basename(authored)} has no compiled ${NESTED_PERSONA_FILENAME}; run \`agentworkforce persona compile ${authored}\` to make it loadable.`
        );
      }
      continue;
    }

    // A stale artifact is the quieter failure: the persona still loads, so
    // nothing looks wrong while the edits sitting in the authoring file are
    // simply absent. Say so, and keep serving the compiled spec — dropping it
    // would turn a forgotten compile into a missing persona.
    const authoredAt = authoredCandidate?.mtimeMs;
    if (authored !== undefined && authoredAt !== undefined && authoredAt > compiledAt) {
      warnings.push(
        `[${layer.source}] ${name}: ${NESTED_PERSONA_FILENAME} is older than ${basename(authored)}, so this persona is loading without the latest edits; re-run \`agentworkforce persona compile ${authored}\`.`
      );
    }
    entries.push({ label: `${name}/${NESTED_PERSONA_FILENAME}`, path, sourceDir });
  }
  return entries;
}

function readLayerEntries(
  dir: string,
  layer: SourceLayer,
  warnings: string[]
): LayerEntry[] {
  if (layer.file) {
    const file = basename(layer.file);
    return [{ label: file, path: join(dir, file), sourceDir: dir }];
  }
  if (layer.nested) return readNestedLayerEntries(dir, layer, warnings);
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((file) => ({ label: file, path: join(dir, file), sourceDir: dir }));
  } catch (err) {
    warnings.push(`[${layer.source}] could not read ${dir}: ${(err as Error).message}`);
    return [];
  }
}

function readLayerDir(
  dir: string,
  layer: SourceLayer,
  warnings: string[],
  filePaths: Map<string, string>
): Map<string, LocalPersonaOverride> {
  const out = new Map<string, LocalPersonaOverride>();
  if (!existsSync(dir)) return out;

  for (const entry of readLayerEntries(dir, layer, warnings)) {
    try {
      const raw = readFileSync(entry.path, 'utf8');
      const parsed = parseOverride(JSON.parse(raw), `[${layer.source}] ${entry.label}`);
      parsed.__sourceDir = entry.sourceDir;
      if (out.has(parsed.id)) {
        warnings.push(`[${layer.source}] ${entry.label}: duplicate id "${parsed.id}" within layer; skipping.`);
        continue;
      }
      out.set(parsed.id, parsed);
      filePaths.set(`${layer.key}:${parsed.id}`, entry.path);
    } catch (err) {
      warnings.push(`[${layer.source}] ${entry.label}: ${(err as Error).message}`);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sidecar path validation shared by local overrides and standalone specs.
 * Mirrors {@link assertSafeRelativePath} but adds the `.md` suffix
 * requirement called out in the schema. Throws on absolute paths,
 * `..` segments, empty strings, or non-`.md` extensions.
 */
function assertSidecarPath(value: unknown, context: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string`);
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') || // covers `\persona.md` and `\\server\share\…` UNC
    /^[A-Za-z]:/.test(value) // covers `C:\persona.md` and drive-relative `C:persona.md`
  ) {
    throw new Error(`${context} must be a relative path; got absolute "${value}"`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`${context} must not contain ".." segments`);
  }
  if (!value.toLowerCase().endsWith('.md')) {
    throw new Error(`${context} must end with .md`);
  }
}

function assertSidecarMode(value: unknown, context: string): void {
  if (!SIDECAR_MD_MODES.includes(value as SidecarMdMode)) {
    throw new Error(`${context} must be one of: ${SIDECAR_MD_MODES.join(', ')}`);
  }
}

function assertInlineSidecarContent(value: unknown, context: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function parseOverride(value: unknown, context: string): LocalPersonaOverride {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  const raw = value;
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  if (raw.extends !== undefined && (typeof raw.extends !== 'string' || !raw.extends.trim())) {
    throw new Error(`${context}.extends must be a non-empty string if provided`);
  }
  if (raw.extends !== undefined && raw.intent !== undefined) {
    throw new Error(`${context}.intent cannot be combined with .extends; omit extends for standalone personas`);
  }
  if (raw.intent !== undefined && (typeof raw.intent !== 'string' || !raw.intent.trim())) {
    throw new Error(`${context}.intent must be a non-empty string if provided`);
  }
  if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== 'string') {
    throw new Error(`${context}.systemPrompt must be a string if provided`);
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new Error(`${context}.description must be a string if provided`);
  }
  let normalizedTags: PersonaTag[] | undefined;
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) {
      throw new Error(`${context}.tags must be an array of strings if provided`);
    }
    const tags = new Set<string>();
    for (const [idx, tag] of raw.tags.entries()) {
      if (typeof tag !== 'string' || !tag.trim()) {
        throw new Error(`${context}.tags[${idx}] must be a non-empty string`);
      }
      const trimmed = tag.trim();
      if (trimmed.length > 64) {
        throw new Error(`${context}.tags[${idx}] must be ≤64 characters`);
      }
      tags.add(trimmed);
    }
    if (tags.size > 0) {
      normalizedTags = Array.from(tags).sort() as PersonaTag[];
    }
  }

  if (raw.skills !== undefined && !Array.isArray(raw.skills)) {
    throw new Error(`${context}.skills must be an array if provided`);
  }
  const inputs = parseInputsShape(raw.inputs, `${context}.inputs`);
  assertStringMap(raw.env, `${context}.env`);
  assertMcpServersShape(raw.mcpServers, `${context}.mcpServers`);
  assertMountShape(raw.mount, `${context}.mount`);
  assertPermissionsShape(raw.permissions, `${context}.permissions`);

  if (raw.tiers !== undefined) {
    throw new Error(
      `${context}.tiers is no longer supported; declare harness/model/systemPrompt/harnessSettings at the top level`
    );
  }
  if (raw.defaultTier !== undefined) {
    throw new Error(
      `${context}.defaultTier is no longer supported (tiers have been removed)`
    );
  }
  // Normalize first, then delegate to persona-kit, which owns both the
  // containment guard and the handler-extension check. Order matters in both
  // directions: validating the raw string and storing a trimmed copy lets
  // " ../x/agent.ts " clear the `..` check as the segment " .." and escape
  // once trimmed, while validating without trimming stores " ./agent.ts",
  // which passes every check and then resolves to a directory named " ."
  // at deploy. Trimming up front makes the validated and stored value one
  // and the same.
  const onEventValue =
    raw.onEvent === undefined
      ? undefined
      : parseOnEvent(
          typeof raw.onEvent === 'string' ? raw.onEvent.trim() : raw.onEvent,
          `${context}.onEvent`
        );
  if (raw.cloud !== undefined && typeof raw.cloud !== 'boolean') {
    throw new Error(`${context}.cloud must be a boolean if provided`);
  }
  if (raw.harness !== undefined) {
    if (typeof raw.harness !== 'string' || !HARNESS_VALUES.includes(raw.harness as Harness)) {
      throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
    }
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model.trim()) {
      throw new Error(`${context}.model must be a non-empty string if provided`);
    }
  }
  if (raw.harnessSettings !== undefined) {
    if (!isPlainObject(raw.harnessSettings)) {
      throw new Error(`${context}.harnessSettings must be an object if provided`);
    }
    assertPartialHarnessSettingsShape(raw.harnessSettings, `${context}.harnessSettings`);
  }

  if (raw.claudeMd !== undefined) assertSidecarPath(raw.claudeMd, `${context}.claudeMd`);
  if (raw.agentsMd !== undefined) assertSidecarPath(raw.agentsMd, `${context}.agentsMd`);
  if (raw.claudeMdContent !== undefined) {
    assertInlineSidecarContent(raw.claudeMdContent, `${context}.claudeMdContent`);
  }
  if (raw.agentsMdContent !== undefined) {
    assertInlineSidecarContent(raw.agentsMdContent, `${context}.agentsMdContent`);
  }
  // Mode is allowed without a same-layer path so an overlay can flip
  // `extend` ↔ `overwrite` while inheriting the path from a lower layer.
  if (raw.claudeMdMode !== undefined) assertSidecarMode(raw.claudeMdMode, `${context}.claudeMdMode`);
  if (raw.agentsMdMode !== undefined) assertSidecarMode(raw.agentsMdMode, `${context}.agentsMdMode`);

  return {
    id: raw.id.trim(),
    ...(typeof raw.extends === 'string' ? { extends: raw.extends.trim() } : {}),
    ...(typeof raw.intent === 'string' ? { intent: raw.intent.trim() } : {}),
    ...(normalizedTags !== undefined ? { tags: normalizedTags } : {}),
    description: raw.description as string | undefined,
    skills: raw.skills as PersonaSpec['skills'] | undefined,
    inputs,
    env: raw.env as LocalPersonaOverride['env'],
    mcpServers: raw.mcpServers as LocalPersonaOverride['mcpServers'],
    mount: raw.mount as LocalPersonaOverride['mount'],
    permissions: raw.permissions as LocalPersonaOverride['permissions'],
    systemPrompt: raw.systemPrompt as string | undefined,
    ...(onEventValue !== undefined ? { onEvent: onEventValue } : {}),
    ...(raw.cloud !== undefined ? { cloud: raw.cloud as boolean } : {}),
    ...(raw.harness !== undefined ? { harness: raw.harness as Harness } : {}),
    ...(raw.model !== undefined ? { model: raw.model as string } : {}),
    ...(raw.harnessSettings !== undefined
      ? { harnessSettings: raw.harnessSettings as Partial<HarnessSettings> }
      : {}),
    ...(typeof raw.claudeMd === 'string' ? { claudeMd: raw.claudeMd } : {}),
    ...(raw.claudeMdMode ? { claudeMdMode: raw.claudeMdMode as SidecarMdMode } : {}),
    ...(typeof raw.agentsMd === 'string' ? { agentsMd: raw.agentsMd } : {}),
    ...(raw.agentsMdMode ? { agentsMdMode: raw.agentsMdMode as SidecarMdMode } : {}),
    ...(typeof raw.claudeMdContent === 'string' ? { claudeMdContent: raw.claudeMdContent } : {}),
    ...(typeof raw.agentsMdContent === 'string' ? { agentsMdContent: raw.agentsMdContent } : {})
  };
}

function parseInputsShape(
  value: unknown,
  context: string
): Record<string, PersonaInputSpec> | undefined {
  return parseInputs(value, context);
}

function assertStringMap(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`${context}.${k} must be a string`);
    }
  }
}

function assertMcpServersShape(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  for (const [name, spec] of Object.entries(value)) {
    const path = `${context}.${name}`;
    if (!isPlainObject(spec)) {
      throw new Error(`${path} must be an object`);
    }
    const type = spec.type;
    if (type !== 'http' && type !== 'sse' && type !== 'stdio') {
      throw new Error(`${path}.type must be one of: http, sse, stdio`);
    }
    if (type === 'stdio') {
      if (typeof spec.command !== 'string' || !spec.command.trim()) {
        throw new Error(`${path}.command must be a non-empty string`);
      }
      if (spec.args !== undefined) {
        if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string')) {
          throw new Error(`${path}.args must be an array of strings`);
        }
      }
      assertStringMap(spec.env, `${path}.env`);
    } else {
      if (typeof spec.url !== 'string' || !spec.url.trim()) {
        throw new Error(`${path}.url must be a non-empty string`);
      }
      assertStringMap(spec.headers, `${path}.headers`);
    }
  }
}

function assertPermissionsShape(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  for (const key of ['allow', 'deny'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.${key} must be an array of non-empty strings`);
    }
  }
  const mode = value.mode;
  if (mode !== undefined && (!PERMISSION_MODES.includes(mode as typeof PERMISSION_MODES[number]))) {
    throw new Error(`${context}.mode must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
}

function assertMountShape(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${context}.enabled must be a boolean if provided`);
  }
  for (const key of ['ignoredPatterns', 'readonlyPatterns'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.${key} must be an array of non-empty strings`);
    }
  }
}

function assertPartialHarnessSettingsShape(value: Record<string, unknown>, context: string): void {
  const {
    reasoning,
    timeoutSeconds,
    sandboxMode,
    approvalPolicy,
    workspaceWriteNetworkAccess,
    webSearch,
    dangerouslyBypassApprovalsAndSandbox
  } = value;
  if (
    reasoning !== undefined &&
    reasoning !== 'low' &&
    reasoning !== 'medium' &&
    reasoning !== 'high'
  ) {
    throw new Error(`${context}.reasoning must be one of: low, medium, high`);
  }
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new Error(`${context}.timeoutSeconds must be a positive number`);
  }
  if (
    sandboxMode !== undefined &&
    !CODEX_SANDBOX_MODES.includes(sandboxMode as CodexSandboxMode)
  ) {
    throw new Error(`${context}.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(', ')}`);
  }
  if (
    approvalPolicy !== undefined &&
    !CODEX_APPROVAL_POLICIES.includes(approvalPolicy as CodexApprovalPolicy)
  ) {
    throw new Error(
      `${context}.approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(', ')}`
    );
  }
  if (workspaceWriteNetworkAccess !== undefined && typeof workspaceWriteNetworkAccess !== 'boolean') {
    throw new Error(`${context}.workspaceWriteNetworkAccess must be a boolean`);
  }
  if (webSearch !== undefined && typeof webSearch !== 'boolean') {
    throw new Error(`${context}.webSearch must be a boolean`);
  }
  if (
    dangerouslyBypassApprovalsAndSandbox !== undefined &&
    typeof dangerouslyBypassApprovalsAndSandbox !== 'boolean'
  ) {
    throw new Error(`${context}.dangerouslyBypassApprovalsAndSandbox must be a boolean`);
  }
}

function findInLibrary(key: string): PersonaSpec | undefined {
  const byIntent = (personaCatalog as Record<string, PersonaSpec | undefined>)[key];
  if (byIntent) return byIntent;
  for (const spec of listBuiltInPersonas()) {
    if (spec.id === key) return spec;
  }
  return undefined;
}

function isStandaloneOverride(
  override: LocalPersonaOverride
): override is LocalPersonaOverride & { intent: string } {
  return override.extends === undefined && override.intent !== undefined;
}

function requireStandaloneField<T>(value: T | undefined, context: string): T {
  if (value === undefined) {
    throw new Error(`${context} is required for standalone personas`);
  }
  return value;
}

function assertStandaloneHarnessSettings(
  settings: Record<string, unknown>,
  context: string
): HarnessSettings {
  return parseHarnessSettings(settings, context);
}

function standaloneSpecFromOverride(
  override: LocalPersonaOverride & { intent: string },
  sidecarWarnings: string[] = [],
  cwd = process.cwd()
): PersonaSpec {
  const context = `standalone persona "${override.id}"`;
  // A handler agent is driven by its `onEvent` entry, not by an operator at a
  // prompt, so the fields configuring an interactive launch are optional here.
  // Requiring them made agents that ship a handler invisible to the cascade:
  // the `agents/` directory added for exactly those agents could not load
  // them, and the error read as though the persona were malformed.
  const isHandler = typeof override.onEvent === 'string' && override.onEvent.trim() !== '';

  const harness = isHandler
    ? override.harness
    : requireStandaloneField(override.harness, `${context}.harness`);
  if (harness !== undefined && !HARNESS_VALUES.includes(harness)) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  const model = isHandler
    ? override.model
    : requireStandaloneField(override.model, `${context}.model`);
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  const fallbackSystemPrompt = override.claudeMdContent ?? override.agentsMdContent;
  const systemPrompt =
    typeof override.systemPrompt === 'string' && override.systemPrompt.trim()
      ? override.systemPrompt
      : fallbackSystemPrompt;
  if (!isHandler && (typeof systemPrompt !== 'string' || !systemPrompt.trim())) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  // `harnessSettings` stays required even for a handler: `PersonaSpec` types it
  // non-optional, and `reasoning`/`timeoutSeconds` have no defensible default to
  // invent on the persona's behalf. Every shipped handler example declares it.
  const settingsRaw = override.harnessSettings;
  if (!settingsRaw || !isPlainObject(settingsRaw)) {
    throw new Error(`${context}.harnessSettings must be an object`);
  }
  const harnessSettings = assertStandaloneHarnessSettings(
    settingsRaw as Record<string, unknown>,
    `${context}.harnessSettings`
  );

  const inputs = override.inputs;
  const env = override.env;
  const mcpServers = override.mcpServers;
  const mount = override.mount;
  const permissions = override.permissions;

  const claudeMdContent = override.claudeMdContent;
  let claudeMd: string | undefined;
  if (override.claudeMd !== undefined && claudeMdContent === undefined) {
    const { abs, warning } = resolveSidecarPath(
      override.claudeMd,
      override.__sourceDir,
      `[${override.id}].claudeMd`
    );
    if (warning) sidecarWarnings.push(warning);
    claudeMd = abs;
  }
  const agentsMdContent = override.agentsMdContent;
  let agentsMd: string | undefined;
  if (override.agentsMd !== undefined && agentsMdContent === undefined) {
    const { abs, warning } = resolveSidecarPath(
      override.agentsMd,
      override.__sourceDir,
      `[${override.id}].agentsMd`
    );
    if (warning) sidecarWarnings.push(warning);
    agentsMd = abs;
  }

  return {
    id: override.id,
    intent: override.intent,
    // Tags are optional per cloud#553 (denormalized catalog metadata).
    ...(override.tags ? { tags: override.tags } : {}),
    description: requireStandaloneField(override.description, `${context}.description`),
    skills: resolveLocalSkillSources(
      override.skills ?? [],
      override.__sourceDir,
      override.id,
      sidecarWarnings,
      cwd
    ),
    ...(inputs ? { inputs } : {}),
    ...(override.onEvent !== undefined ? { onEvent: override.onEvent } : {}),
    ...(override.cloud !== undefined ? { cloud: override.cloud } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    harnessSettings,
    ...(env ? { env } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mount ? { mount } : {}),
    ...(permissions ? { permissions } : {}),
    ...(claudeMd ? { claudeMd } : {}),
    ...(override.claudeMdMode ? { claudeMdMode: override.claudeMdMode } : {}),
    ...(agentsMd ? { agentsMd } : {}),
    ...(override.agentsMdMode ? { agentsMdMode: override.agentsMdMode } : {}),
    ...(claudeMdContent ? { claudeMdContent } : {}),
    ...(agentsMdContent ? { agentsMdContent } : {})
  };
}

/**
 * Mutual-recursion with resolveInLayer: given a base key, walk strictly-lower
 * layers until we find a persona with that id (local layers) or an id/intent
 * match in the library. Returns a fully-merged PersonaSpec or undefined.
 */
function findInLowerLayers(
  key: string,
  startLayerIdx: number,
  layers: readonly SourceLayer[],
  overrides: Map<string, Map<string, LocalPersonaOverride>>,
  resolving: Set<string>,
  sidecarWarnings: string[],
  cwd: string
): PersonaSpec | undefined {
  for (let i = startLayerIdx; i < layers.length; i++) {
    const layer = layers[i];
    const layerOverrides = overrides.get(layer.key);
    if (!layerOverrides) continue;
    const overrideId = findOverrideIdInLayer(key, layerOverrides, layer.source);
    if (overrideId) {
      return resolveInLayer(overrideId, i, layers, overrides, resolving, sidecarWarnings, cwd);
    }
  }
  return findInLibrary(key);
}

function findOverrideIdInLayer(
  key: string,
  layerOverrides: Map<string, LocalPersonaOverride>,
  source: PersonaSource
): string | undefined {
  if (layerOverrides.has(key)) return key;

  const matches: string[] = [];
  for (const [id, override] of layerOverrides) {
    if (override.intent === key) matches.push(id);
  }
  if (matches.length > 1) {
    throw new Error(
      `extends "${key}" is ambiguous in ${source}; matched local persona intents on ids: ${matches.join(', ')}`
    );
  }
  return matches[0];
}

function resolveInLayer(
  id: string,
  layerIdx: number,
  layers: readonly SourceLayer[],
  overrides: Map<string, Map<string, LocalPersonaOverride>>,
  resolving: Set<string>,
  sidecarWarnings: string[],
  cwd: string
): PersonaSpec {
  const layer = layers[layerIdx];
  const key = `${layer.key}:${id}`;
  if (resolving.has(key)) {
    throw new Error(`extends cycle detected through ${[...resolving, key].join(' -> ')}`);
  }
  resolving.add(key);
  try {
    const override = overrides.get(layer.key)?.get(id);
    if (!override) {
      throw new Error(`internal: resolveInLayer called for missing ${key}`);
    }
    if (isStandaloneOverride(override)) {
      return standaloneSpecFromOverride(override, sidecarWarnings, cwd);
    }
    const baseKey = override.extends ?? override.id;
    const base = findInLowerLayers(
      baseKey,
      layerIdx + 1,
      layers,
      overrides,
      resolving,
      sidecarWarnings,
      cwd
    );
    if (!base) {
      const lowerLayers = [
        ...layers.slice(layerIdx + 1).map((lower) => lower.source),
        'library'
      ].join(', ');
      const hint = override.extends
        ? `extends "${override.extends}" does not match any persona in lower layers (${lowerLayers})`
        : `no lower-layer persona with id "${override.id}" to implicitly inherit from; add extends or define the persona in a lower layer`;
      throw new Error(hint);
    }
    return mergeOverride(base, override, sidecarWarnings, cwd);
  } finally {
    resolving.delete(key);
  }
}

// Local skill source detection mirrors persona-kit's local provider: a
// non-URL path ending in `.md`. Anything else (prpm refs, skill.sh URLs)
// passes through untouched.
const LOCAL_SKILL_MD_RE = /\.md$/i;
const SKILL_URL_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Modification time of a regular file, or undefined if it is not one. */
function fileMtimeMs(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve relative local skill sources (`./skills/foo.md`) declared by an
 * override against the directory of the JSON file that declared them, the
 * same way sidecar paths resolve. Two fallbacks cover the other layouts in
 * the wild: persona packs keep `skills/` at the package root (one level
 * above `personas/`), and installer-rewritten specs use cwd-relative
 * `__assets` paths.
 *
 * Missing files surface as warnings and the skill is dropped, matching
 * sidecar semantics. A broken pointer must not abort the launch: skill
 * installs run as one `&&` chain, so a failing `cp` would otherwise kill
 * the harness spawn AND prevent the skill cache marker from being written,
 * forcing every subsequent spawn to re-download all skills.
 */
function resolveLocalSkillSources(
  skills: readonly PersonaSkill[],
  sourceDir: string | undefined,
  personaId: string,
  warnings: string[],
  cwd = process.cwd()
): PersonaSkill[] {
  return skills.flatMap((skill) => {
    const source = skill.source;
    if (
      typeof source !== 'string' ||
      SKILL_URL_PREFIX_RE.test(source) ||
      !LOCAL_SKILL_MD_RE.test(source)
    ) {
      return [skill];
    }
    if (isAbsolute(source)) {
      if (isFile(source)) return [skill];
      warnings.push(
        `[${personaId}].skills "${skill.id}": local skill file not found at ${source}; skipping skill`
      );
      return [];
    }
    const candidates = [
      ...(sourceDir
        ? [resolvePath(sourceDir, source), resolvePath(sourceDir, '..', source)]
        : []),
      resolvePath(cwd, source)
    ];
    const resolved = candidates.find(isFile);
    if (!resolved) {
      warnings.push(
        `[${personaId}].skills "${skill.id}": local skill file not found (tried ${candidates.join(', ')}); skipping skill`
      );
      return [];
    }
    return [{ ...skill, source: resolved }];
  });
}

/**
 * Resolve a sidecar markdown path declared on `override` against the
 * directory of the JSON file that declared it. Returns the absolute path
 * along with any warnings about missing files; missing-file is non-fatal
 * (the field is dropped from the resolved spec) so a developer iterating
 * locally doesn't get blocked by a typo.
 */
function resolveSidecarPath(
  relPath: string | undefined,
  sourceDir: string | undefined,
  label: string
): { abs?: string; warning?: string } {
  if (!relPath) return {};
  if (!sourceDir) {
    return { warning: `${label}: cannot resolve "${relPath}" without a source directory` };
  }
  const abs = resolvePath(sourceDir, relPath);
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      return { warning: `${label}: sidecar file not found at ${abs}` };
    }
    // Surface real I/O failures (permissions, etc.) — silently treating
    // an EACCES as "missing" hides config bugs from developers.
    return { warning: `${label}: sidecar at ${abs} is not readable: ${e.message}` };
  }
  if (!stat.isFile()) {
    return { warning: `${label}: sidecar at ${abs} is not a file` };
  }
  return { abs };
}

function mergeOverride(
  base: PersonaSpec,
  override: LocalPersonaOverride,
  sidecarWarnings: string[] = [],
  cwd = process.cwd()
): PersonaSpec {
  const harness = override.harness ?? base.harness;
  const model = override.model ?? base.model;
  const systemPrompt = override.systemPrompt ?? base.systemPrompt;
  // An overlay that only tweaks env must not strip the handler entry that
  // makes the base a deployable agent.
  const onEvent = override.onEvent ?? base.onEvent;
  const cloud = override.cloud ?? base.cloud;
  const harnessSettings: HarnessSettings = parseHarnessSettings({
    ...base.harnessSettings,
    ...(override.harnessSettings ?? {})
  }, `persona[${override.id}].harnessSettings`);

  const env =
    override.env || base.env
      ? { ...(base.env ?? {}), ...(override.env ?? {}) }
      : undefined;
  const inputs =
    override.inputs || base.inputs
      ? { ...(base.inputs ?? {}), ...(override.inputs ?? {}) }
      : undefined;
  const mcpServers =
    override.mcpServers || base.mcpServers
      ? { ...(base.mcpServers ?? {}), ...(override.mcpServers ?? {}) }
      : undefined;
  const mount = mergeMount(base.mount, override.mount);
  const permissions = mergePermissions(base.permissions, override.permissions);

  // When the override sets a new path, the override owns the channel —
  // drop inherited `*Content` so the override path isn't shadowed by an
  // inlined built-in body. When the override leaves the path alone, the
  // inherited content (if any) stays.
  let claudeMd: string | undefined = base.claudeMd;
  let claudeMdContent: string | undefined = base.claudeMdContent;
  if (override.claudeMdContent !== undefined) {
    claudeMd = undefined;
    claudeMdContent = override.claudeMdContent;
  } else if (override.claudeMd !== undefined) {
    const { abs, warning } = resolveSidecarPath(
      override.claudeMd,
      override.__sourceDir,
      `[${override.id}].claudeMd`
    );
    if (warning) sidecarWarnings.push(warning);
    claudeMd = abs;
    claudeMdContent = undefined;
  }
  let agentsMd: string | undefined = base.agentsMd;
  let agentsMdContent: string | undefined = base.agentsMdContent;
  if (override.agentsMdContent !== undefined) {
    agentsMd = undefined;
    agentsMdContent = override.agentsMdContent;
  } else if (override.agentsMd !== undefined) {
    const { abs, warning } = resolveSidecarPath(
      override.agentsMd,
      override.__sourceDir,
      `[${override.id}].agentsMd`
    );
    if (warning) sidecarWarnings.push(warning);
    agentsMd = abs;
    agentsMdContent = undefined;
  }
  const claudeMdMode = override.claudeMdMode ?? base.claudeMdMode;
  const agentsMdMode = override.agentsMdMode ?? base.agentsMdMode;

  const mergedTags = override.tags ?? base.tags;
  // Skills replace wholesale, so resolution context is unambiguous: an
  // override's skills resolve against its own __sourceDir; inherited skills
  // were already resolved when the base layer was built.
  const skills =
    override.skills !== undefined
      ? resolveLocalSkillSources(
          override.skills,
          override.__sourceDir,
          override.id,
          sidecarWarnings,
          cwd
        )
      : base.skills;
  return {
    id: override.id,
    intent: base.intent,
    ...(mergedTags ? { tags: mergedTags } : {}),
    description: override.description ?? base.description,
    skills,
    ...(inputs ? { inputs } : {}),
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(cloud !== undefined ? { cloud } : {}),
    ...(harness !== undefined ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    harnessSettings,
    ...(env ? { env } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mount ? { mount } : {}),
    ...(permissions ? { permissions } : {}),
    ...(claudeMd ? { claudeMd } : {}),
    ...(claudeMdMode ? { claudeMdMode } : {}),
    ...(agentsMd ? { agentsMd } : {}),
    ...(agentsMdMode ? { agentsMdMode } : {}),
    ...(claudeMdContent ? { claudeMdContent } : {}),
    ...(agentsMdContent ? { agentsMdContent } : {})
  };
}

/**
 * Test-only seam. Built-in personas are the only specs that can carry
 * `claudeMdContent` / `agentsMdContent` (the catalog generator inlines
 * sibling `.md` files at build time), and none ship sidecars today —
 * so the file-based loader path can't be used to produce a `base` with
 * inherited content. This export lets regression tests construct that
 * scenario directly.
 *
 * @internal
 */
export const __mergeOverrideForTests = mergeOverride;

function mergeMount(
  base: PersonaMount | undefined,
  override: PersonaMount | undefined
): PersonaMount | undefined {
  if (!base && !override) return undefined;
  const ignoredPatterns = [
    ...(base?.ignoredPatterns ?? []),
    ...(override?.ignoredPatterns ?? [])
  ];
  const readonlyPatterns = [
    ...(base?.readonlyPatterns ?? []),
    ...(override?.readonlyPatterns ?? [])
  ];
  const enabled = override?.enabled ?? base?.enabled;
  if (ignoredPatterns.length === 0 && readonlyPatterns.length === 0) {
    return enabled === true ? { enabled: true } : undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(ignoredPatterns.length > 0 ? { ignoredPatterns } : {}),
    ...(readonlyPatterns.length > 0 ? { readonlyPatterns } : {})
  };
}

function mergePermissions(
  base: PersonaPermissions | undefined,
  override: PersonaPermissions | undefined
): PersonaPermissions | undefined {
  if (!base && !override) return undefined;
  const allow = dedupe([...(base?.allow ?? []), ...(override?.allow ?? [])]);
  const deny = dedupe([...(base?.deny ?? []), ...(override?.deny ?? [])]);
  const mode = override?.mode ?? base?.mode;
  const out: PersonaPermissions = {};
  if (allow.length > 0) out.allow = allow;
  if (deny.length > 0) out.deny = deny;
  if (mode) out.mode = mode;
  return Object.keys(out).length > 0 ? out : undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function loadLocalPersonas(options: LoadOptions = {}): LoadedLocalPersonas {
  const cwd = options.cwd ?? process.cwd();
  const sourceDirs = buildPersonaSourceDirectories(options);
  const warnings: string[] = [...sourceDirs.config.warnings];
  const personaPath = options.personaPath ? resolvePath(options.personaPath) : undefined;
  const orderedSources: Array<PersonaSourceDirectory & { file?: string }> = [
    ...(personaPath
      ? [{ source: 'path', dir: dirname(personaPath), configurable: false, file: personaPath }]
      : []),
    ...sourceDirs.directories
  ];
  const layers: SourceLayer[] = orderedSources.map((sourceDir, idx) => ({
    key: `${idx}:${sourceDir.source}:${sourceDir.file ?? sourceDir.dir}`,
    source: sourceDir.source,
    dir: sourceDir.dir,
    ...(sourceDir.file ? { file: sourceDir.file } : {}),
    ...(sourceDir.nested ? { nested: true } : {})
  }));

  const overrides = new Map<string, Map<string, LocalPersonaOverride>>();
  const layerFilePaths = new Map<string, string>();
  for (const layer of layers) {
    overrides.set(layer.key, readLayerDir(layer.dir, layer, warnings, layerFilePaths));
  }

  const byId = new Map<string, PersonaSpec>();
  const sources = new Map<string, PersonaSource>();
  const paths = new Map<string, string>();

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const layerOverrides = overrides.get(layer.key);
    if (!layerOverrides) continue;
    for (const id of layerOverrides.keys()) {
      if (byId.has(id)) continue; // higher-layer already won
      const sidecarWarnings: string[] = [];
      try {
        const resolved = resolveInLayer(id, i, layers, overrides, new Set(), sidecarWarnings, cwd);
        byId.set(id, resolved);
        sources.set(id, layer.source);
        const filePath = layerFilePaths.get(`${layer.key}:${id}`);
        if (filePath) paths.set(id, filePath);
        for (const warning of sidecarWarnings) {
          warnings.push(`[${layer.source}] ${warning}`);
        }
      } catch (err) {
        warnings.push(`[${layer.source}] ${id}: ${(err as Error).message}`);
      }
    }
  }

  return { byId, sources, paths, warnings };
}
