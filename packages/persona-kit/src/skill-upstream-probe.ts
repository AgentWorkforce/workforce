import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSkillSource } from './skills.js';
import type { SkillCacheMarker, SkillUpstreamRecord } from './skill-cache.js';

// ---------------------------------------------------------------------------
// Upstream drift detection
// ---------------------------------------------------------------------------
//
// The persistent skill cache is keyed by a source-string fingerprint, so an
// upstream publish that doesn't change the persona's `source` string (the
// common case: floating refs like `@org/skill` or `github.com/org/repo#x`)
// never rotates the fingerprint on its own. This module adds a cheap,
// opt-in second check:
//
//   • At install time, `buildUpstreamRecordsFromCacheDir` reads the
//     lockfiles the installers wrote into the cache dir (`prpm.lock`,
//     `skills-lock.json`) and resolves a stable upstream identity per skill:
//       - prpm        → the resolved `version`
//       - skill.sh    → the GitHub blob SHA of the installed SKILL.md
//   • On launch, `detectSkillUpstreamDrift` re-probes each recorded skill in
//     parallel and reports whether ANY of them moved. prpm is one registry
//     GET; github is a conditional GET (`If-None-Match: "<sha>"`) that comes
//     back 304 with no body when nothing changed.
//
// Everything fails OPEN: a network error, timeout, rate-limit, or malformed
// response for a given skill is treated as "no drift detected" for that
// skill. A flaky registry must never block or slow a launch beyond the
// timeout — the worst case is running slightly stale until the next clean
// probe.

const DEFAULT_TIMEOUT_MS = 5000;
const PRPM_REGISTRY_BASE = 'https://registry.prpm.dev/api/v1/packages';
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Minimal fetch surface the probes actually use. Deliberately narrower than
 * the DOM `fetch` overload set so tests can pass a plain stub without
 * wrestling the `URL | RequestInfo` union.
 */
export type MinimalFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ProbeDeps {
  /** Injectable fetch (defaults to global). Tests pass a stub. */
  fetchImpl?: MinimalFetch;
  /** Per-request timeout. Defaults to 5s. */
  timeoutMs?: number;
}

export interface SkillDriftDetail {
  skillId: string;
  source: string;
  kind: SkillUpstreamRecord['kind'];
  /** True when upstream moved relative to the recorded identity. */
  drifted: boolean;
  /** Human-readable note for logs (recorded → current, or the fail-open reason). */
  note: string;
}

export interface UpstreamDriftResult {
  drifted: boolean;
  details: SkillDriftDetail[];
}

function withTimeout(timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  // Not unref'd: the whole point of this timer is to enforce the probe
  // deadline. `cancel()` clears it on the normal (settled) path so it never
  // lingers; on a hung fetch it must stay live so the abort actually fires.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------
// prpm
// ---------------------------------------------------------------------------

/**
 * Parse the prpm.lock the installer wrote into `cacheDir` into a
 * packageRef → resolved-version map. prpm.lock keys are `<packageRef>#<format>`
 * (e.g. `@agent-relay/foo#claude`); we index by the bare packageRef so a
 * persona source string can find its row regardless of harness format.
 */
function readPrpmLockVersions(cacheDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(join(cacheDir, 'prpm.lock'), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const packages = (parsed as { packages?: Record<string, unknown> })?.packages;
  if (!packages || typeof packages !== 'object') return out;
  for (const [key, value] of Object.entries(packages)) {
    const version = (value as { version?: unknown })?.version;
    if (typeof version !== 'string') continue;
    const hashIdx = key.lastIndexOf('#');
    const packageRef = hashIdx >= 0 ? key.slice(0, hashIdx) : key;
    // First write wins; multiple harness formats of the same package resolve
    // to the same version in practice.
    if (!out.has(packageRef)) out.set(packageRef, version);
  }
  return out;
}

async function probePrpmLatestVersion(
  packageRef: string,
  deps: Required<ProbeDeps>
): Promise<string | null> {
  const url = `${PRPM_REGISTRY_BASE}/${encodeURIComponent(packageRef)}`;
  const { signal, cancel } = withTimeout(deps.timeoutMs);
  try {
    const res = await deps.fetchImpl(url, {
      signal,
      headers: { accept: 'application/json' }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      latest_version?: { version?: unknown };
    };
    const v = body?.latest_version?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// skill.sh / GitHub blob
// ---------------------------------------------------------------------------

interface SkillsLockEntry {
  source?: string;
  sourceType?: string;
  skillPath?: string;
  computedHash?: string;
}

function readSkillsLock(cacheDir: string): Record<string, SkillsLockEntry> {
  try {
    const raw = readFileSync(join(cacheDir, 'skills-lock.json'), 'utf8');
    const parsed = JSON.parse(raw) as { skills?: Record<string, SkillsLockEntry> };
    return parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
  } catch {
    return {};
  }
}

/**
 * Owner/repo + optional ref extracted from a resolved skill.sh source. The
 * resolver normalizes both supported forms into `packageRef`:
 *   - `<repoUrl>#<skillName>`            (default branch)
 *   - `<repoUrl>/tree/<ref>#<skillName>` (explicit ref)
 */
function parseGithubRepoRef(
  resolvedPackageRef: string
): { owner: string; repo: string; ref?: string } | null {
  const [left] = resolvedPackageRef.split('#');
  const treeMatch = left.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/([^/\s]+)$/i
  );
  if (treeMatch) {
    return { owner: treeMatch[1], repo: treeMatch[2], ref: treeMatch[3] };
  }
  const repoMatch = left.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
  );
  if (repoMatch) {
    return { owner: repoMatch[1], repo: repoMatch[2] };
  }
  return null;
}

/**
 * Build the GitHub Contents API URL for a skill's SKILL.md from the
 * skills-lock `skillPath` plus the repo/ref parsed off the resolved source.
 * Returns null when we can't form a precise file URL (caller fails open).
 */
function buildGithubBlobUrl(
  resolvedPackageRef: string,
  skillPath: string
): string | null {
  const repo = parseGithubRepoRef(resolvedPackageRef);
  if (!repo) return null;
  const path = skillPath.replace(/^\/+/, '');
  const base = `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/contents/${path}`;
  return repo.ref ? `${base}?ref=${encodeURIComponent(repo.ref)}` : base;
}

async function probeGithubBlobSha(
  blobUrl: string,
  knownSha: string | undefined,
  deps: Required<ProbeDeps>
): Promise<{ sha: string | null; unchanged: boolean }> {
  const { signal, cancel } = withTimeout(deps.timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'agentworkforce-skill-cache'
    };
    // Conditional GET: GitHub returns the blob SHA as the ETag, so an
    // unchanged file comes back 304 with no body — the cheapest possible
    // "did it move?" check.
    if (knownSha) headers['if-none-match'] = `"${knownSha}"`;
    const res = await deps.fetchImpl(blobUrl, { signal, headers });
    if (res.status === 304) return { sha: knownSha ?? null, unchanged: true };
    if (!res.ok) return { sha: null, unchanged: false };
    const body = (await res.json()) as { sha?: unknown };
    const sha = typeof body?.sha === 'string' ? body.sha : null;
    return { sha, unchanged: sha !== null && sha === knownSha };
  } catch {
    return { sha: null, unchanged: false };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * After a successful install, derive each skill's upstream identity from the
 * lockfiles the installers wrote into `cacheDir`. Returns a map keyed by
 * skill id; a skill maps to `undefined` when it has no usable upstream
 * representation (local `.md` files — already covered by the fingerprint).
 *
 * skill.sh entries require one extra GitHub GET apiece to resolve the current
 * blob SHA; that cost is paid on the (already slow) install path, not on
 * cache-hit launches.
 */
export async function buildUpstreamRecordsFromCacheDir(
  cacheDir: string,
  skills: readonly { id: string; source: string }[],
  deps?: ProbeDeps
): Promise<Map<string, SkillUpstreamRecord | undefined>> {
  const resolved: Required<ProbeDeps> = {
    fetchImpl: deps?.fetchImpl ?? globalThis.fetch,
    timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  const prpmVersions = readPrpmLockVersions(cacheDir);
  const skillsLock = readSkillsLock(cacheDir);
  const out = new Map<string, SkillUpstreamRecord | undefined>();

  await Promise.all(
    skills.map(async (skill) => {
      let parsed;
      try {
        parsed = resolveSkillSource(skill.source);
      } catch {
        out.set(skill.id, undefined);
        return;
      }
      if (parsed.kind === 'prpm') {
        const version = prpmVersions.get(parsed.packageRef);
        out.set(
          skill.id,
          version
            ? { kind: 'prpm', packageRef: parsed.packageRef, version }
            : undefined
        );
        return;
      }
      if (parsed.kind === 'skill.sh') {
        const lockEntry = skillsLock[parsed.installedName];
        const blobUrl =
          lockEntry?.skillPath !== undefined
            ? buildGithubBlobUrl(parsed.packageRef, lockEntry.skillPath)
            : null;
        if (!blobUrl) {
          out.set(skill.id, undefined);
          return;
        }
        const { sha } = await probeGithubBlobSha(blobUrl, undefined, resolved);
        out.set(
          skill.id,
          sha ? { kind: 'github-blob', blobUrl, sha } : undefined
        );
        return;
      }
      // local + anything else: no upstream identity.
      out.set(skill.id, undefined);
    })
  );
  return out;
}

/**
 * Re-probe each skill that has a recorded upstream identity and report
 * whether any moved. Fail-open per skill: probe errors count as "no drift".
 *
 * Skills with no `upstream` record are skipped — either local files (covered
 * by the fingerprint) or skills whose install-time probe failed. A skill that
 * SHOULD have an upstream but doesn't (e.g. a v1 marker upgraded in place) is
 * reported as drifted so the reinstall captures its identity for next time.
 */
export async function detectSkillUpstreamDrift(
  marker: SkillCacheMarker,
  deps?: ProbeDeps
): Promise<UpstreamDriftResult> {
  const resolved: Required<ProbeDeps> = {
    fetchImpl: deps?.fetchImpl ?? globalThis.fetch,
    timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };

  const details = await Promise.all(
    marker.skills.map(async (skill): Promise<SkillDriftDetail | null> => {
      const upstream = skill.upstream;
      if (!upstream) {
        // Distinguish "remote skill missing its record" (force reinstall to
        // capture it) from "local skill, nothing to probe" (skip). We treat a
        // skill whose source resolves to prpm/skill.sh but has no record as
        // drifted; local/unknown sources are skipped.
        let remote = false;
        try {
          const k = resolveSkillSource(skill.source).kind;
          remote = k === 'prpm' || k === 'skill.sh';
        } catch {
          remote = false;
        }
        if (!remote) return null;
        return {
          skillId: skill.id,
          source: skill.source,
          kind: 'prpm',
          drifted: true,
          note: 'no upstream record (pre-v2 marker) — reinstall to capture identity'
        };
      }

      if (upstream.kind === 'prpm') {
        const current = await probePrpmLatestVersion(upstream.packageRef, resolved);
        if (current === null) {
          return {
            skillId: skill.id,
            source: skill.source,
            kind: 'prpm',
            drifted: false,
            note: `probe failed (fail-open); staying on ${upstream.version}`
          };
        }
        const drifted = current !== upstream.version;
        return {
          skillId: skill.id,
          source: skill.source,
          kind: 'prpm',
          drifted,
          note: drifted
            ? `prpm ${upstream.version} → ${current}`
            : `prpm ${upstream.version} (current)`
        };
      }

      // github-blob
      const { sha, unchanged } = await probeGithubBlobSha(
        upstream.blobUrl,
        upstream.sha,
        resolved
      );
      if (unchanged) {
        return {
          skillId: skill.id,
          source: skill.source,
          kind: 'github-blob',
          drifted: false,
          note: `github blob ${upstream.sha.slice(0, 12)} (unchanged)`
        };
      }
      if (sha === null) {
        return {
          skillId: skill.id,
          source: skill.source,
          kind: 'github-blob',
          drifted: false,
          note: 'probe failed (fail-open); staying on cached blob'
        };
      }
      return {
        skillId: skill.id,
        source: skill.source,
        kind: 'github-blob',
        drifted: true,
        note: `github blob ${upstream.sha.slice(0, 12)} → ${sha.slice(0, 12)}`
      };
    })
  );

  const filtered = details.filter((d): d is SkillDriftDetail => d !== null);
  return {
    drifted: filtered.some((d) => d.drifted),
    details: filtered
  };
}

/**
 * Parse a duration like `24h`, `30m`, `90s`, `0`, or `never` into
 * milliseconds. Returns:
 *   - a positive number  → TTL window
 *   - `0`                → always check (every launch)
 *   - `null`             → never check (drift detection disabled)
 *   - `undefined`        → unparseable (caller applies its own default)
 */
export function parseCheckInterval(
  raw: string | undefined
): number | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'never' || v === 'off' || v === 'false') return null;
  if (v === '0') return 0;
  const m = v.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'd':
      return n * 86_400_000;
    case 'h':
    case undefined: // a bare number means hours
      return n * 3_600_000;
    default:
      return undefined;
  }
}

/**
 * Decide whether a drift check is due given the marker's last check time and
 * the configured interval (ms; `0` = always, `null` = never).
 */
export function isUpstreamCheckDue(
  marker: SkillCacheMarker,
  intervalMs: number | null,
  now: number = Date.now()
): boolean {
  if (intervalMs === null) return false;
  if (intervalMs === 0) return true;
  if (!marker.lastUpstreamCheckAt) return true;
  const last = Date.parse(marker.lastUpstreamCheckAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMs;
}
