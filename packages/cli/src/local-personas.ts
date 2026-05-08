import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  listBuiltInPersonas,
  personaCatalog,
  PERSONA_TAGS,
  PERSONA_TIERS,
  SIDECAR_MD_MODES,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type HarnessSettings,
  type McpServerSpec,
  type PersonaInputSpec,
  type PersonaMount,
  type PersonaPermissions,
  type PersonaRuntime,
  type PersonaSpec,
  type PersonaTag,
  type PersonaTier,
  type SidecarMdMode
} from '@agentworkforce/workload-router';

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
  /** Convenience: replaces systemPrompt on every inherited tier. Ignored if `tiers` is also set. */
  systemPrompt?: string;
  /** Per-tier overrides. If a tier is set here, it replaces the inherited tier wholesale. */
  tiers?: Partial<Record<PersonaTier, Partial<PersonaRuntime>>>;
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

interface SourceLayer {
  key: string;
  source: PersonaSource;
  dir: string;
}

export interface PersonaSourceDirectory {
  source: PersonaSource;
  dir: string;
  configurable: boolean;
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
  warnings: string[];
}

export interface LoadOptions {
  cwd?: string;
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

function dedupeDirs(dirs: readonly string[], warnings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const normalized = normalizePersonaDir(dir);
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
  const userPersonaDir = normalizePersonaDir(
    options.userPersonaDir ?? options.homeDir ?? defaultUserPersonaDir(workforceHomeDir)
  );
  const configPath = normalizePersonaDir(
    options.configPath ?? defaultPersonaConfigPath(workforceHomeDir)
  );
  const warnings: string[] = [];
  const rawConfig = readRawPersonaSourceConfig(configPath, warnings);
  const configuredDirs =
    options.personaDirs ?? rawConfig?.personaDirs ?? [userPersonaDir];
  const defaultCreateTarget = options.defaultCreateTarget ?? rawConfig?.defaultCreateTarget;

  return {
    configPath,
    personaDirs: dedupeDirs(configuredDirs, warnings),
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
    ...config.personaDirs.map((dir, idx) => ({
      source: sourceForPersonaDir(dir, idx, config.userPersonaDir),
      dir,
      configurable: true
    }))
  ];
  return { directories, config };
}

function readLayerDir(
  dir: string,
  layer: SourceLayer,
  warnings: string[]
): Map<string, LocalPersonaOverride> {
  const out = new Map<string, LocalPersonaOverride>();
  if (!existsSync(dir)) return out;

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    warnings.push(`[${layer.source}] could not read ${dir}: ${(err as Error).message}`);
    return out;
  }

  for (const file of entries) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = parseOverride(JSON.parse(raw), `[${layer.source}] ${file}`);
      parsed.__sourceDir = dir;
      if (out.has(parsed.id)) {
        warnings.push(`[${layer.source}] ${file}: duplicate id "${parsed.id}" within layer; skipping.`);
        continue;
      }
      out.set(parsed.id, parsed);
    } catch (err) {
      warnings.push(`[${layer.source}] ${file}: ${(err as Error).message}`);
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
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
      throw new Error(`${context}.tags must be a non-empty array of tags if provided`);
    }
    for (const [idx, tag] of raw.tags.entries()) {
      if (!PERSONA_TAGS.includes(tag as PersonaTag)) {
        throw new Error(
          `${context}.tags[${idx}] must be one of: ${PERSONA_TAGS.join(', ')}`
        );
      }
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
  assertTiersShape(raw.tiers, `${context}.tiers`);

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
    id: raw.id,
    extends: raw.extends as string | undefined,
    intent: raw.intent as string | undefined,
    tags: raw.tags as PersonaTag[] | undefined,
    description: raw.description as string | undefined,
    skills: raw.skills as PersonaSpec['skills'] | undefined,
    inputs,
    env: raw.env as LocalPersonaOverride['env'],
    mcpServers: raw.mcpServers as LocalPersonaOverride['mcpServers'],
    mount: raw.mount as LocalPersonaOverride['mount'],
    permissions: raw.permissions as LocalPersonaOverride['permissions'],
    systemPrompt: raw.systemPrompt as string | undefined,
    tiers: raw.tiers as LocalPersonaOverride['tiers'],
    ...(typeof raw.claudeMd === 'string' ? { claudeMd: raw.claudeMd } : {}),
    ...(raw.claudeMdMode ? { claudeMdMode: raw.claudeMdMode as SidecarMdMode } : {}),
    ...(typeof raw.agentsMd === 'string' ? { agentsMd: raw.agentsMd } : {}),
    ...(raw.agentsMdMode ? { agentsMdMode: raw.agentsMdMode as SidecarMdMode } : {}),
    ...(typeof raw.claudeMdContent === 'string' ? { claudeMdContent: raw.claudeMdContent } : {}),
    ...(typeof raw.agentsMdContent === 'string' ? { agentsMdContent: raw.agentsMdContent } : {})
  };
}

const INPUT_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function assertInputName(name: string, context: string): void {
  if (!INPUT_NAME_RE.test(name)) {
    throw new Error(`${context} must be an env-style name matching ${INPUT_NAME_RE.source}`);
  }
}

function parseInputsShape(
  value: unknown,
  context: string
): Record<string, PersonaInputSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, PersonaInputSpec> = {};
  for (const [name, raw] of Object.entries(value)) {
    assertInputName(name, `${context}.${name}`);
    if (typeof raw === 'string') {
      if (!raw) throw new Error(`${context}.${name} default must be non-empty`);
      out[name] = { default: raw };
      continue;
    }
    if (!isPlainObject(raw)) {
      throw new Error(`${context}.${name} must be a string default or an object`);
    }
    const spec = raw as Record<string, unknown>;
    if (spec.description !== undefined && (typeof spec.description !== 'string' || !spec.description.trim())) {
      throw new Error(`${context}.${name}.description must be a non-empty string if provided`);
    }
    if (spec.env !== undefined) {
      if (typeof spec.env !== 'string' || !spec.env.trim()) {
        throw new Error(`${context}.${name}.env must be a non-empty string if provided`);
      }
      assertInputName(spec.env, `${context}.${name}.env`);
    }
    if (spec.default !== undefined && (typeof spec.default !== 'string' || !spec.default)) {
      throw new Error(`${context}.${name}.default must be a non-empty string if provided`);
    }
    out[name] = {
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      ...(typeof spec.env === 'string' ? { env: spec.env } : {}),
      ...(typeof spec.default === 'string' ? { default: spec.default } : {})
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  if (mode !== undefined && typeof mode !== 'string') {
    throw new Error(`${context}.mode must be a string if provided`);
  }
}

function assertMountShape(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  for (const key of ['ignoredPatterns', 'readonlyPatterns'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.${key} must be an array of non-empty strings`);
    }
  }
}

function assertTiersShape(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  for (const [tierName, runtime] of Object.entries(value)) {
    const path = `${context}.${tierName}`;
    if (!isPlainObject(runtime)) {
      throw new Error(`${path} must be an object`);
    }
    if (runtime.model !== undefined && typeof runtime.model !== 'string') {
      throw new Error(`${path}.model must be a string`);
    }
    if (runtime.harness !== undefined && typeof runtime.harness !== 'string') {
      throw new Error(`${path}.harness must be a string`);
    }
    if (runtime.systemPrompt !== undefined && typeof runtime.systemPrompt !== 'string') {
      throw new Error(`${path}.systemPrompt must be a string`);
    }
    if (runtime.harnessSettings !== undefined && !isPlainObject(runtime.harnessSettings)) {
      throw new Error(`${path}.harnessSettings must be an object`);
    }
    if (runtime.harnessSettings !== undefined) {
      assertPartialHarnessSettingsShape(runtime.harnessSettings, `${path}.harnessSettings`);
    }
    if (runtime.claudeMd !== undefined) assertSidecarPath(runtime.claudeMd, `${path}.claudeMd`);
    if (runtime.agentsMd !== undefined) assertSidecarPath(runtime.agentsMd, `${path}.agentsMd`);
    if (runtime.claudeMdContent !== undefined) {
      assertInlineSidecarContent(runtime.claudeMdContent, `${path}.claudeMdContent`);
    }
    if (runtime.agentsMdContent !== undefined) {
      assertInlineSidecarContent(runtime.agentsMdContent, `${path}.agentsMdContent`);
    }
    // Tier-level mode without a tier-level path is allowed: it overrides
    // top-level mode for this tier while inheriting the inherited path.
    if (runtime.claudeMdMode !== undefined) assertSidecarMode(runtime.claudeMdMode, `${path}.claudeMdMode`);
    if (runtime.agentsMdMode !== undefined) assertSidecarMode(runtime.agentsMdMode, `${path}.agentsMdMode`);
  }
}

function assertPartialHarnessSettingsShape(value: Record<string, unknown>, context: string): void {
  const {
    reasoning,
    timeoutSeconds,
    sandboxMode,
    approvalPolicy,
    workspaceWriteNetworkAccess,
    webSearch
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

function assertStandaloneRuntime(
  runtime: Partial<PersonaRuntime> | undefined,
  context: string,
  fallbackSystemPrompt?: string
): PersonaRuntime {
  if (!runtime) {
    throw new Error(`${context} is required for standalone personas`);
  }
  if (
    typeof runtime.harness !== 'string' ||
    !HARNESS_VALUES.includes(runtime.harness as PersonaRuntime['harness'])
  ) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  if (typeof runtime.model !== 'string' || !runtime.model.trim()) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  const systemPrompt =
    typeof runtime.systemPrompt === 'string' && runtime.systemPrompt.trim()
      ? runtime.systemPrompt
      : fallbackSystemPrompt;
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  const settings = runtime.harnessSettings as unknown;
  if (!isPlainObject(settings)) {
    throw new Error(`${context}.harnessSettings must be an object`);
  }
  const harnessSettings = assertStandaloneHarnessSettings(settings, `${context}.harnessSettings`);
  return {
    harness: runtime.harness as PersonaRuntime['harness'],
    model: runtime.model,
    systemPrompt,
    harnessSettings,
    ...(typeof runtime.claudeMdContent === 'string' ? { claudeMdContent: runtime.claudeMdContent } : {}),
    ...(typeof runtime.agentsMdContent === 'string' ? { agentsMdContent: runtime.agentsMdContent } : {})
  };
}

function assertStandaloneHarnessSettings(
  settings: Record<string, unknown>,
  context: string
): HarnessSettings {
  assertPartialHarnessSettingsShape(settings, context);
  const reasoning = settings.reasoning;
  if (reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') {
    throw new Error(`${context}.reasoning must be one of: low, medium, high`);
  }
  const timeoutSeconds = settings.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${context}.timeoutSeconds must be a positive number`);
  }

  const out: HarnessSettings = { reasoning, timeoutSeconds };
  if (settings.sandboxMode !== undefined) {
    out.sandboxMode = settings.sandboxMode as CodexSandboxMode;
  }
  if (settings.approvalPolicy !== undefined) {
    out.approvalPolicy = settings.approvalPolicy as CodexApprovalPolicy;
  }
  if (settings.workspaceWriteNetworkAccess !== undefined) {
    out.workspaceWriteNetworkAccess = settings.workspaceWriteNetworkAccess as boolean;
  }
  if (settings.webSearch !== undefined) {
    out.webSearch = settings.webSearch as boolean;
  }
  return out;
}

function standaloneSpecFromOverride(
  override: LocalPersonaOverride & { intent: string },
  sidecarWarnings: string[] = []
): PersonaSpec {
  const tiers = {} as Record<PersonaTier, PersonaRuntime>;
  const rawTiers = requireStandaloneField(
    override.tiers,
    `standalone persona "${override.id}".tiers`
  );
  const topLevelFallbackSystemPrompt =
    typeof override.systemPrompt === 'string' && override.systemPrompt.trim()
      ? override.systemPrompt
      : override.claudeMdContent ?? override.agentsMdContent;
  for (const tier of PERSONA_TIERS) {
    const tierFallbackSystemPrompt =
      rawTiers[tier]?.claudeMdContent ??
      rawTiers[tier]?.agentsMdContent ??
      topLevelFallbackSystemPrompt;
    const runtime = assertStandaloneRuntime(
      rawTiers[tier],
      `standalone persona "${override.id}".tiers.${tier}`,
      tierFallbackSystemPrompt
    );
    const tierOverride = rawTiers[tier];
    if (tierOverride?.claudeMd !== undefined) {
      const { abs, warning } = resolveSidecarPath(
        tierOverride.claudeMd,
        override.__sourceDir,
        `[${override.id}].tiers.${tier}.claudeMd`
      );
      if (warning) sidecarWarnings.push(warning);
      if (abs) runtime.claudeMd = abs;
    }
    if (tierOverride?.agentsMd !== undefined) {
      const { abs, warning } = resolveSidecarPath(
        tierOverride.agentsMd,
        override.__sourceDir,
        `[${override.id}].tiers.${tier}.agentsMd`
      );
      if (warning) sidecarWarnings.push(warning);
      if (abs) runtime.agentsMd = abs;
    }
    if (tierOverride?.claudeMdMode) runtime.claudeMdMode = tierOverride.claudeMdMode;
    if (tierOverride?.agentsMdMode) runtime.agentsMdMode = tierOverride.agentsMdMode;
    tiers[tier] = runtime;
  }

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
    tags: requireStandaloneField(
      override.tags,
      `standalone persona "${override.id}".tags`
    ),
    description: requireStandaloneField(
      override.description,
      `standalone persona "${override.id}".description`
    ),
    skills: override.skills ?? [],
    ...(inputs ? { inputs } : {}),
    tiers,
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
  sidecarWarnings: string[]
): PersonaSpec | undefined {
  for (let i = startLayerIdx; i < layers.length; i++) {
    const layer = layers[i];
    const layerOverrides = overrides.get(layer.key);
    if (!layerOverrides) continue;
    const overrideId = findOverrideIdInLayer(key, layerOverrides, layer.source);
    if (overrideId) {
      return resolveInLayer(overrideId, i, layers, overrides, resolving, sidecarWarnings);
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
  sidecarWarnings: string[]
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
      return standaloneSpecFromOverride(override, sidecarWarnings);
    }
    const baseKey = override.extends ?? override.id;
    const base = findInLowerLayers(baseKey, layerIdx + 1, layers, overrides, resolving, sidecarWarnings);
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
    return mergeOverride(base, override, sidecarWarnings);
  } finally {
    resolving.delete(key);
  }
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
  sidecarWarnings: string[] = []
): PersonaSpec {
  const tiers = {} as Record<PersonaTier, PersonaRuntime>;
  for (const tier of PERSONA_TIERS) {
    const baseRuntime = base.tiers[tier];
    const tierOverride = override.tiers?.[tier];
    let merged: PersonaRuntime = tierOverride
      ? {
          ...baseRuntime,
          ...tierOverride,
          harnessSettings: {
            ...baseRuntime.harnessSettings,
            ...(tierOverride.harnessSettings ?? {})
          }
        }
      : baseRuntime;
    if (tierOverride?.claudeMd !== undefined) {
      const { abs, warning } = resolveSidecarPath(
        tierOverride.claudeMd,
        override.__sourceDir,
        `[${override.id}].tiers.${tier}.claudeMd`
      );
      if (warning) sidecarWarnings.push(warning);
      // Override owns the channel — clear inherited content so the override
      // path isn't masked by base.claudeMdContent in downstream selection.
      merged = { ...merged };
      delete merged.claudeMdContent;
      if (abs) merged.claudeMd = abs;
      else delete merged.claudeMd;
    }
    if (tierOverride?.agentsMd !== undefined) {
      const { abs, warning } = resolveSidecarPath(
        tierOverride.agentsMd,
        override.__sourceDir,
        `[${override.id}].tiers.${tier}.agentsMd`
      );
      if (warning) sidecarWarnings.push(warning);
      merged = { ...merged };
      delete merged.agentsMdContent;
      if (abs) merged.agentsMd = abs;
      else delete merged.agentsMd;
    }
    if (override.systemPrompt && !tierOverride?.systemPrompt) {
      merged = { ...merged, systemPrompt: override.systemPrompt };
    }
    tiers[tier] = merged;
  }

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

  return {
    id: override.id,
    intent: base.intent,
    tags: override.tags ?? base.tags,
    description: override.description ?? base.description,
    skills: override.skills ?? base.skills,
    ...(inputs ? { inputs } : {}),
    tiers,
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
  if (ignoredPatterns.length === 0 && readonlyPatterns.length === 0) return undefined;
  return {
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
  const sourceDirs = buildPersonaSourceDirectories(options);
  const warnings: string[] = [...sourceDirs.config.warnings];
  const layers: SourceLayer[] = sourceDirs.directories.map((sourceDir, idx) => ({
    key: `${idx}:${sourceDir.source}:${sourceDir.dir}`,
    source: sourceDir.source,
    dir: sourceDir.dir
  }));

  const overrides = new Map<string, Map<string, LocalPersonaOverride>>();
  for (const layer of layers) {
    overrides.set(layer.key, readLayerDir(layer.dir, layer, warnings));
  }

  const byId = new Map<string, PersonaSpec>();
  const sources = new Map<string, PersonaSource>();

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const layerOverrides = overrides.get(layer.key);
    if (!layerOverrides) continue;
    for (const id of layerOverrides.keys()) {
      if (byId.has(id)) continue; // higher-layer already won
      const sidecarWarnings: string[] = [];
      try {
        const resolved = resolveInLayer(id, i, layers, overrides, new Set(), sidecarWarnings);
        byId.set(id, resolved);
        sources.set(id, layer.source);
        for (const warning of sidecarWarnings) {
          warnings.push(`[${layer.source}] ${warning}`);
        }
      } catch (err) {
        warnings.push(`[${layer.source}] ${id}: ${(err as Error).message}`);
      }
    }
  }

  return { byId, sources, warnings };
}
