import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  personaCatalog,
  PERSONA_TAGS,
  PERSONA_TIERS,
  type McpServerSpec,
  type PersonaPermissions,
  type PersonaRuntime,
  type PersonaSpec,
  type PersonaTag,
  type PersonaTier
} from '@agentworkforce/workload-router';

/**
 * User-defined persona override. Local files are partial overlays — only the
 * fields you specify replace the inherited base; everything else cascades down
 * through cwd → configured persona dirs → library.
 *
 * `extends` names the base explicitly by id or intent. If omitted, the loader
 * implicitly inherits from the same-id persona found in the next lower layer.
 */
export interface LocalPersonaOverride {
  id: string;
  extends?: string;
  /**
   * Classification tags. When provided, replaces the inherited base's tags
   * entirely (matching the replace-wholesale semantics used for `skills`).
   */
  tags?: PersonaTag[];
  description?: string;
  skills?: PersonaSpec['skills'];
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Permission policy. `allow` and `deny` append to the base's lists (dedup
   * on merge); `mode` replaces the base's mode when set.
   */
  permissions?: PersonaPermissions;
  /** Convenience: replaces systemPrompt on every inherited tier. Ignored if `tiers` is also set. */
  systemPrompt?: string;
  /** Per-tier overrides. If a tier is set here, it replaces the inherited tier wholesale. */
  tiers?: Partial<Record<PersonaTier, Partial<PersonaRuntime>>>;
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
  return join(cwd, '.agentworkforce', 'workforce');
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

function readConfigPersonaDirs(path: string, warnings: string[]): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isPlainObject(parsed)) {
      warnings.push(`[config] ${path}: must be a JSON object`);
      return undefined;
    }
    const dirs = parsed.personaDirs;
    if (dirs === undefined) return undefined;
    if (
      !Array.isArray(dirs) ||
      dirs.some((dir) => typeof dir !== 'string' || !dir.trim())
    ) {
      warnings.push(`[config] ${path}: personaDirs must be an array of non-empty strings`);
      return undefined;
    }
    return dirs.map((dir) => normalizePersonaDir(dir, dirname(path)));
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
  const configuredDirs =
    options.personaDirs ?? readConfigPersonaDirs(configPath, warnings) ?? [userPersonaDir];

  return {
    configPath,
    personaDirs: dedupeDirs(configuredDirs, warnings),
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
  writeFileSync(
    config.configPath,
    JSON.stringify({ personaDirs: config.personaDirs }, null, 2) + '\n',
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
  assertStringMap(raw.env, `${context}.env`);
  assertMcpServersShape(raw.mcpServers, `${context}.mcpServers`);
  assertPermissionsShape(raw.permissions, `${context}.permissions`);
  assertTiersShape(raw.tiers, `${context}.tiers`);

  return {
    id: raw.id,
    extends: raw.extends as string | undefined,
    tags: raw.tags as PersonaTag[] | undefined,
    description: raw.description as string | undefined,
    skills: raw.skills as PersonaSpec['skills'] | undefined,
    env: raw.env as LocalPersonaOverride['env'],
    mcpServers: raw.mcpServers as LocalPersonaOverride['mcpServers'],
    permissions: raw.permissions as LocalPersonaOverride['permissions'],
    systemPrompt: raw.systemPrompt as string | undefined,
    tiers: raw.tiers as LocalPersonaOverride['tiers']
  };
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
  }
}

function findInLibrary(key: string): PersonaSpec | undefined {
  const byIntent = (personaCatalog as Record<string, PersonaSpec>)[key];
  if (byIntent) return byIntent;
  for (const spec of Object.values(personaCatalog)) {
    if (spec.id === key) return spec;
  }
  return undefined;
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
  resolving: Set<string>
): PersonaSpec | undefined {
  for (let i = startLayerIdx; i < layers.length; i++) {
    const layer = layers[i];
    const layerOverrides = overrides.get(layer.key);
    if (layerOverrides?.has(key)) {
      return resolveInLayer(key, i, layers, overrides, resolving);
    }
  }
  return findInLibrary(key);
}

function resolveInLayer(
  id: string,
  layerIdx: number,
  layers: readonly SourceLayer[],
  overrides: Map<string, Map<string, LocalPersonaOverride>>,
  resolving: Set<string>
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
    const baseKey = override.extends ?? override.id;
    const base = findInLowerLayers(baseKey, layerIdx + 1, layers, overrides, resolving);
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
    return mergeOverride(base, override);
  } finally {
    resolving.delete(key);
  }
}

function mergeOverride(base: PersonaSpec, override: LocalPersonaOverride): PersonaSpec {
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
    if (override.systemPrompt && !tierOverride?.systemPrompt) {
      merged = { ...merged, systemPrompt: override.systemPrompt };
    }
    tiers[tier] = merged;
  }

  const env =
    override.env || base.env
      ? { ...(base.env ?? {}), ...(override.env ?? {}) }
      : undefined;
  const mcpServers =
    override.mcpServers || base.mcpServers
      ? { ...(base.mcpServers ?? {}), ...(override.mcpServers ?? {}) }
      : undefined;
  const permissions = mergePermissions(base.permissions, override.permissions);

  return {
    id: override.id,
    intent: base.intent,
    tags: override.tags ?? base.tags,
    description: override.description ?? base.description,
    skills: override.skills ?? base.skills,
    tiers,
    ...(env ? { env } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(permissions ? { permissions } : {})
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
      try {
        const resolved = resolveInLayer(id, i, layers, overrides, new Set());
        byId.set(id, resolved);
        sources.set(id, layer.source);
      } catch (err) {
        warnings.push(`[${layer.source}] ${id}: ${(err as Error).message}`);
      }
    }
  }

  return { byId, sources, warnings };
}
