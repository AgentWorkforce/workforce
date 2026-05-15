import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Harness, PersonaSkill, SkillSourceKind } from './types.js';

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
// Cache invalidation has two layers:
//
//   1. Source-key (always-on). The fingerprint folds in the harness, each
//      skill's `(id, source)` pair, and the SHA-256 of any local `.md`
//      sources. Changing a source string or editing a local file rotates the
//      fingerprint and produces a fresh cache entry — no upstream traffic.
//
//   2. Upstream drift check (opt-in, on a TTL). At install time we record
//      each remote skill's upstream identity (prpm version, github blob SHA).
//      On launch, if the marker's `lastUpstreamCheckAt` is older than the
//      configured interval, lightweight HTTPS probes (one per skill, in
//      parallel) compare the recorded identity to current upstream — any
//      mismatch flips the cache hit into a miss so the reinstall picks up
//      the new content. Failures fail-open (treated as "no drift detected")
//      so the launch never blocks on a flaky registry.
//
// `--refresh-skills` is the unconditional override — it always reinstalls.
// `--no-skill-cache` (and `AGENTWORKFORCE_NO_SKILL_CACHE=1`) bypass the cache
// entirely.

const MARKER_FILENAME = '.aw-skill-cache.json';
/** Latest marker schema version this module writes. v1 reads remain supported. */
const MARKER_SCHEMA_VERSION = 2 as const;
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

/**
 * Per-skill upstream identity stored at install time and probed on launch to
 * detect drift past a fingerprint that hasn't changed.
 *
 * - `prpm`: the registry's `latest_version.version` at install time. A
 *   subsequent launch compares to the registry's current latest.
 * - `github-blob`: the blob SHA of the SKILL.md file at install time. A
 *   subsequent launch fetches the file's blob SHA (or sends an
 *   `If-None-Match: "<sha>"` conditional GET) and compares.
 *
 * Skills with no usable upstream representation (e.g. local `.md` files) are
 * recorded without an `upstream` field — they're covered by the content
 * hash already folded into the fingerprint.
 */
export type SkillUpstreamRecord =
  | { kind: 'prpm'; packageRef: string; version: string }
  | { kind: 'github-blob'; blobUrl: string; sha: string };

export interface SkillCacheMarkerSkill {
  id: string;
  source: string;
  sourceKind?: SkillSourceKind;
  upstream?: SkillUpstreamRecord;
}

export interface SkillCacheMarker {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  fingerprint: string;
  harness: Harness;
  /** ISO-8601 timestamp of the most recent successful install into this dir. */
  installedAt: string;
  /**
   * ISO-8601 timestamp of the most recent successful (or attempted-and-clean)
   * upstream probe. Omitted on freshly-installed markers that haven't been
   * probed yet — but the install path also writes an initial value so the
   * first launch within the TTL window doesn't need to probe.
   */
  lastUpstreamCheckAt?: string;
  skills: readonly SkillCacheMarkerSkill[];
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
 * string — upstream version bumps are picked up by the separate drift-check
 * machinery in `detectSkillUpstreamDrift`, not by the fingerprint.
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
    // Pinned to 1 even though the marker schema is v2: the fingerprint is a
    // CONTENT key, not a marker version key. Bumping it would gratuitously
    // invalidate every cache entry in the wild.
    v: 1,
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
 *
 * Accepts both schema v1 (the original, no upstream metadata) and v2 (adds
 * `lastUpstreamCheckAt` and per-skill `upstream`). v1 markers are upgraded
 * in-place to the v2 shape with no upstream records — the next drift-check
 * pass will treat the absence as "needs to be recorded" and probe live.
 */
export function readSkillCacheMarker(cacheDir: string): SkillCacheMarker | null {
  try {
    const raw = readFileSync(join(cacheDir, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as {
      schemaVersion?: number;
      fingerprint?: unknown;
      harness?: unknown;
      installedAt?: unknown;
      lastUpstreamCheckAt?: unknown;
      skills?: unknown;
    };
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) return null;
    if (typeof parsed.fingerprint !== 'string') return null;
    if (typeof parsed.harness !== 'string') return null;
    if (typeof parsed.installedAt !== 'string') return null;
    if (!Array.isArray(parsed.skills)) return null;
    return {
      schemaVersion: MARKER_SCHEMA_VERSION,
      fingerprint: parsed.fingerprint,
      harness: parsed.harness as Harness,
      installedAt: parsed.installedAt,
      ...(typeof parsed.lastUpstreamCheckAt === 'string'
        ? { lastUpstreamCheckAt: parsed.lastUpstreamCheckAt }
        : {}),
      skills: parsed.skills.map(normalizeMarkerSkill)
    };
  } catch {
    return null;
  }
}

function normalizeMarkerSkill(input: unknown): SkillCacheMarkerSkill {
  const obj = (input ?? {}) as Partial<SkillCacheMarkerSkill> & {
    upstream?: unknown;
  };
  const out: SkillCacheMarkerSkill = {
    id: typeof obj.id === 'string' ? obj.id : '',
    source: typeof obj.source === 'string' ? obj.source : ''
  };
  if (typeof obj.sourceKind === 'string') out.sourceKind = obj.sourceKind as SkillSourceKind;
  const upstream = obj.upstream;
  if (upstream && typeof upstream === 'object') {
    const u = upstream as Record<string, unknown>;
    if (u.kind === 'prpm' && typeof u.packageRef === 'string' && typeof u.version === 'string') {
      out.upstream = { kind: 'prpm', packageRef: u.packageRef, version: u.version };
    } else if (
      u.kind === 'github-blob' &&
      typeof u.blobUrl === 'string' &&
      typeof u.sha === 'string'
    ) {
      out.upstream = { kind: 'github-blob', blobUrl: u.blobUrl, sha: u.sha };
    }
  }
  return out;
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
    ...(marker.lastUpstreamCheckAt !== undefined
      ? { lastUpstreamCheckAt: marker.lastUpstreamCheckAt }
      : {}),
    skills: marker.skills
  };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, MARKER_FILENAME), JSON.stringify(body, null, 2));
}

/**
 * Update an existing marker's `lastUpstreamCheckAt` (and optionally any
 * per-skill upstream records that were freshly probed). Used by the launch
 * path after a drift-free probe so subsequent launches within the TTL window
 * can skip the check entirely.
 *
 * No-ops silently if the marker file is missing or malformed — callers
 * should already have validated it.
 */
export function updateSkillCacheMarkerUpstream(
  cacheDir: string,
  patch: {
    lastUpstreamCheckAt: string;
    /** Optional per-skill upstream records to overlay; missing entries keep their existing values. */
    skills?: ReadonlyMap<string, SkillUpstreamRecord | undefined>;
  }
): void {
  const existing = readSkillCacheMarker(cacheDir);
  if (!existing) return;
  const updated: SkillCacheMarker = {
    ...existing,
    lastUpstreamCheckAt: patch.lastUpstreamCheckAt,
    skills: existing.skills.map((skill) => {
      const overlay = patch.skills?.get(skill.id);
      if (overlay === undefined && !patch.skills?.has(skill.id)) return skill;
      const next: SkillCacheMarkerSkill = {
        id: skill.id,
        source: skill.source,
        ...(skill.sourceKind !== undefined ? { sourceKind: skill.sourceKind } : {})
      };
      if (overlay !== undefined) next.upstream = overlay;
      return next;
    })
  };
  writeFileSync(join(cacheDir, MARKER_FILENAME), JSON.stringify(updated, null, 2));
}

/**
 * True when the cache dir has a marker file whose fingerprint matches the
 * expected value. Mismatches are treated as invalid (caller should reinstall);
 * since the cache dir name IS the fingerprint, a mismatch only happens on
 * partial writes or manual tampering.
 *
 * This is purely a source-key check — it does NOT consult upstream. Use
 * `detectSkillUpstreamDrift` separately to fold in drift detection.
 */
export function isSkillCacheValid(cacheDir: string, fingerprint: string): boolean {
  const marker = readSkillCacheMarker(cacheDir);
  return marker !== null && marker.fingerprint === fingerprint;
}
