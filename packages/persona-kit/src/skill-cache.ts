import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Harness, PersonaSkill } from './types.js';

// ---------------------------------------------------------------------------
// Persistent skill-install cache
// ---------------------------------------------------------------------------
//
// Each interactive launch (`agentworkforce agent <persona>`) used to spawn a
// fresh `npx prpm install …` for every declared skill, even when nothing about
// the skill set had changed since the last run — `npx`, registry resolution,
// and tarball fetches added several seconds of latency to every spawn.
//
// To skip that work we maintain a content-addressed cache under
// `~/.agentworkforce/workforce/cache/plugins/<fingerprint>/` keyed by a stable
// hash of the persona's skill set (and, for local sources, the file contents).
// The first launch with a given fingerprint installs into the cache dir; later
// launches with the same fingerprint reuse the existing dir directly:
//
//   • claude: pass the cache dir to `claude --plugin-dir <cacheDir>`.
//   • opencode / codex (mount mode): rsync the cache contents into the mount
//     before launch so the harness sees the expected layout.
//
// Invalidation is deliberately conservative: the cache **never auto-expires**.
// A skill source string change (e.g. bumping `@org/skill` to a versioned ref)
// changes the fingerprint and produces a fresh cache entry. To force a refresh
// past unchanged sources, callers use the CLI's `--refresh-skills` flag or set
// `AGENTWORKFORCE_NO_SKILL_CACHE=1`.

const MARKER_FILENAME = '.aw-skill-cache.json';
const MARKER_SCHEMA_VERSION = 1 as const;
const LOCAL_MD_RE = /\.md$/i;
const URL_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface SkillCacheFingerprintInput {
  harness: Harness;
  skills: readonly PersonaSkill[];
  /**
   * Repo root used to resolve relative local skill paths so the fingerprint
   * folds in the .md file contents — an edit invalidates the cache without
   * the user needing to bump a version.
   */
  repoRoot?: string;
}

export interface SkillCacheMarker {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  fingerprint: string;
  harness: Harness;
  /** ISO-8601 timestamp of the most recent successful install into this dir. */
  installedAt: string;
  skills: ReadonlyArray<{ id: string; source: string }>;
}

/**
 * Stable fingerprint identifying a (harness, skill set) combination.
 *
 * The fingerprint is the SHA-256 (first 32 hex chars) of a canonical JSON
 * encoding of:
 *   - the harness name
 *   - each skill's `id` and `source`, sorted by id
 *   - for local `.md` sources resolvable against `repoRoot`, the SHA-256 of
 *     the file's bytes (so edits to a local skill invalidate the cache)
 *
 * Remote sources (prpm refs, github URLs) are hashed only by the source
 * string — upstream version bumps will NOT be picked up automatically and
 * require `--refresh-skills` or a source-string change to refresh the cache.
 */
export function computeSkillCacheFingerprint(
  input: SkillCacheFingerprintInput
): string {
  const skills = [...input.skills]
    .map((skill) => ({
      id: skill.id,
      source: skill.source,
      localHash: hashLocalSourceIfPresent(skill.source, input.repoRoot)
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = stableStringify({
    v: MARKER_SCHEMA_VERSION,
    harness: input.harness,
    skills
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeysDeep(v)])
    );
  }
  return value;
}

function hashLocalSourceIfPresent(
  source: string,
  repoRoot: string | undefined
): string | null {
  if (URL_PREFIX_RE.test(source)) return null;
  if (!LOCAL_MD_RE.test(source)) return null;
  const trimmed = source.startsWith('./') ? source.slice(2) : source;
  const abs = isAbsolute(trimmed)
    ? trimmed
    : repoRoot
      ? resolve(repoRoot, trimmed)
      : null;
  if (!abs) return null;
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    // File missing or unreadable at fingerprint time: omit the content hash
    // so the fingerprint still stabilizes off the source string alone. The
    // install will fail later with a clearer error than we could surface
    // here.
    return null;
  }
}

/**
 * Root directory under `~/.agentworkforce/workforce/cache/plugins/` that
 * holds one subdir per fingerprint. Distinct from
 * `~/.agentworkforce/workforce/sessions/` (which is wiped after each run) so
 * cached installs persist across launches.
 */
export function skillCacheRoot(): string {
  return join(homedir(), '.agentworkforce', 'workforce', 'cache', 'plugins');
}

/** Cache dir for a given fingerprint. May or may not exist yet. */
export function resolveSkillCacheDir(fingerprint: string): string {
  return join(skillCacheRoot(), fingerprint);
}

/**
 * Read the cache marker if present and well-formed. Returns null on any
 * I/O or JSON failure so callers can transparently fall through to a fresh
 * install.
 */
export function readSkillCacheMarker(cacheDir: string): SkillCacheMarker | null {
  try {
    const raw = readFileSync(join(cacheDir, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillCacheMarker>;
    if (parsed.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
    if (typeof parsed.fingerprint !== 'string') return null;
    if (typeof parsed.harness !== 'string') return null;
    if (typeof parsed.installedAt !== 'string') return null;
    if (!Array.isArray(parsed.skills)) return null;
    return parsed as SkillCacheMarker;
  } catch {
    return null;
  }
}

/**
 * Write the marker after a successful install. The marker's presence is the
 * sole signal that the dir is a complete cache entry — never call this if
 * the install subprocess exited non-zero.
 */
export function writeSkillCacheMarker(
  cacheDir: string,
  marker: Omit<SkillCacheMarker, 'schemaVersion' | 'installedAt'> & {
    installedAt?: string;
  }
): void {
  const body: SkillCacheMarker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    fingerprint: marker.fingerprint,
    harness: marker.harness,
    installedAt: marker.installedAt ?? new Date().toISOString(),
    skills: marker.skills
  };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, MARKER_FILENAME), JSON.stringify(body, null, 2));
}

/**
 * True when the cache dir has a marker file whose fingerprint matches the
 * expected value. Mismatches are treated as invalid (caller should reinstall);
 * since the cache dir name IS the fingerprint, a mismatch only happens on
 * partial writes or manual tampering.
 */
export function isSkillCacheValid(cacheDir: string, fingerprint: string): boolean {
  const marker = readSkillCacheMarker(cacheDir);
  return marker !== null && marker.fingerprint === fingerprint;
}
