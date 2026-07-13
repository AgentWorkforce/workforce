import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Warm-launch fast path.
 *
 * This module is the only code that runs before the harness child is spawned
 * on a warm launch, so it must stay dependency-light: node builtins only, no
 * workspace packages, no npm deps. The heavy CLI module graph
 * (`cli-impl.js`) is imported by the thin entry *after* the child is already
 * running.
 *
 * The contract: a prior full launch wrote a {@link LaunchPlan} recording the
 * exact spawn (bin + argv), the warm mount location, and stat-level digests
 * of every input that fed persona resolution. `tryFastAgentLaunch` re-checks
 * those digests, atomically claims the warm mount via rename, and spawns.
 * Any doubt — missing plan, changed digest, set env var, claimed mount —
 * returns null and the caller takes the full launch path, which rebuilds
 * both the plan and the warm mount at exit. Correctness never depends on the
 * fast path engaging; it only depends on the digests being strict enough to
 * refuse when the slow path would have produced different session inputs.
 */

export const LAUNCH_PLAN_SCHEMA_VERSION = 1;

/** Mirrors persona-kit's skill-cache marker filename (see skill-cache.ts). */
const SKILL_CACHE_MARKER_FILENAME = '.aw-skill-cache.json';
/** Mirrors @relayfile/local-mount's mount marker filename. */
const MOUNT_MARKER_FILENAME = '.relayfile-local-mount';

export interface StatDigest {
  path: string;
  /** null = the path did not exist at plan time (and must still not exist). */
  size: number | null;
  mtimeMs: number | null;
}

export interface LaunchPlan {
  schemaVersion: number;
  cliVersion: string;
  cwd: string;
  selector: string;
  personaId: string;
  harness: string;
  model: string;
  /**
   * Stat digests of every file/dir that feeds persona resolution or mount
   * pattern construction. All must match exactly for the plan to be trusted.
   */
  digests: StatDigest[];
  /**
   * Env vars that fed resolution, pinned to their plan-time values
   * (null = unset). Persona input names, workforce-home overrides, and — for
   * harnesses where relay MCP injection applies — the RELAY_* config. Any
   * difference at fast-launch time means the resolved spec could differ, so
   * the fast path refuses.
   */
  envExact: Record<string, string | null>;
  skillCache: {
    dir: string;
    fingerprint: string;
    /** Raw AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL at plan time (null = unset). */
    upstreamIntervalRaw: string | null;
    /** Parsed interval; null = checks disabled. */
    upstreamIntervalMs: number | null;
  };
  spawn: {
    /** Absolute path resolved at plan time; must still exist. */
    binPath: string;
    args: string[];
    /**
     * Env vars layered over process.env for the child. Only persona-input
     * values resolved from declared defaults land here — literal strings
     * from the digest-pinned persona spec, never values sourced from the
     * caller's environment.
     */
    envAdditions: Record<string, string>;
  };
  mount: {
    warmDir: string;
    ignoredPatterns: string[];
    readonlyPatterns: string[];
  };
}

export interface FastLaunch {
  plan: LaunchPlan;
  child: ChildProcess;
  sessionRoot: string;
  mountDir: string;
  /** Path to the claimed autosync state snapshot from the previous session. */
  statePath: string;
  startedAt: number;
}

function agentworkforceCacheRoot(): string {
  return join(homedir(), '.agentworkforce', 'workforce', 'cache');
}

export function launchPlanKey(cwd: string, selector: string): string {
  return createHash('sha256').update(`${cwd}\0${selector}`).digest('hex').slice(0, 32);
}

export function launchPlanPath(cwd: string, selector: string): string {
  return join(agentworkforceCacheRoot(), 'launch-plans', `${launchPlanKey(cwd, selector)}.json`);
}

export function warmMountDir(cwd: string, selector: string): string {
  return join(agentworkforceCacheRoot(), 'warm-mounts', launchPlanKey(cwd, selector));
}

export function statDigestOf(path: string): StatDigest {
  try {
    const st = statSync(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { path, size: null, mtimeMs: null };
  }
}

function statDigestStillHolds(digest: StatDigest): boolean {
  const current = statDigestOf(digest.path);
  return current.size === digest.size && current.mtimeMs === digest.mtimeMs;
}

function readCliVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Cheap re-validation of the persisted skill cache: the marker must carry the
 * same fingerprint the plan was built against, and the TTL'd upstream drift
 * check must not be due (running it needs the network and the full CLI).
 */
function skillCacheStillValid(plan: LaunchPlan): boolean {
  const rawInterval = process.env.AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL ?? null;
  if (rawInterval !== plan.skillCache.upstreamIntervalRaw) return false;
  const marker = readJsonFile(join(plan.skillCache.dir, SKILL_CACHE_MARKER_FILENAME)) as {
    fingerprint?: unknown;
    lastUpstreamCheckAt?: unknown;
    installedAt?: unknown;
  } | null;
  if (!marker || marker.fingerprint !== plan.skillCache.fingerprint) return false;
  const intervalMs = plan.skillCache.upstreamIntervalMs;
  if (intervalMs === null) return true;
  const reference =
    typeof marker.lastUpstreamCheckAt === 'string'
      ? Date.parse(marker.lastUpstreamCheckAt)
      : typeof marker.installedAt === 'string'
        ? Date.parse(marker.installedAt)
        : NaN;
  if (!Number.isFinite(reference)) return false;
  return Date.now() - reference < intervalMs;
}

function generateFastSessionRoot(personaId: string): string {
  const sessionId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return join(homedir(), '.agentworkforce', 'workforce', 'sessions', `${personaId}-${sessionId}`);
}

function perfMark(label: string): void {
  if (process.env.AGENTWORKFORCE_PERF !== '1') return;
  process.stderr.write(`[perf] +${performance.now().toFixed(1)}ms ${label}\n`);
}

/**
 * Attempt the warm fast launch for `agentworkforce agent <selector>`.
 *
 * Returns the spawned child (plus everything the post-spawn bookkeeping
 * needs) when every validation held and the warm mount was claimed, or null
 * when the caller must run the full launch path. Never throws for "plan is
 * stale" conditions — only for programmer errors.
 */
export function tryFastAgentLaunch(rest: readonly string[]): FastLaunch | null {
  // Any flag beyond a bare selector changes launch semantics → full path.
  if (rest.length !== 1 || rest[0].startsWith('-')) return null;
  const selector = rest[0];
  const cwd = process.cwd();

  const plan = readJsonFile(launchPlanPath(cwd, selector)) as LaunchPlan | null;
  if (!plan || plan.schemaVersion !== LAUNCH_PLAN_SCHEMA_VERSION) return null;
  if (plan.cwd !== cwd || plan.selector !== selector) return null;
  const cliVersion = readCliVersion();
  if (!cliVersion || plan.cliVersion !== cliVersion) return null;
  if (process.env.AGENTWORKFORCE_NO_SKILL_CACHE === '1') return null;

  for (const [name, pinned] of Object.entries(plan.envExact)) {
    if ((process.env[name] ?? null) !== pinned) return null;
  }
  for (const digest of plan.digests) {
    if (!statDigestStillHolds(digest)) return null;
  }
  if (!skillCacheStillValid(plan)) return null;
  if (!existsSync(plan.spawn.binPath)) return null;

  const warmDir = plan.mount.warmDir;
  const warmMount = join(warmDir, 'mount');
  const warmState = join(warmDir, 'state.json');
  if (!existsSync(join(warmMount, MOUNT_MARKER_FILENAME))) return null;
  if (!existsSync(warmState)) return null;

  perfMark('fast-launch: plan validated');

  // Claim the warm mount by renaming it into a fresh session root. rename is
  // atomic on the same volume, so a concurrent launch of the same persona
  // loses the race cleanly (ENOENT) and takes the full path instead.
  const sessionRoot = generateFastSessionRoot(plan.personaId);
  const mountDir = join(sessionRoot, 'mount');
  const statePath = join(sessionRoot, 'warm-state.json');
  try {
    mkdirSync(sessionRoot, { recursive: true });
    renameSync(warmMount, mountDir);
  } catch {
    try {
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return null;
  }
  try {
    renameSync(warmState, statePath);
  } catch {
    // Without the state snapshot a reattach could resurrect files deleted
    // from the project while the mount sat warm. Give the mount back and
    // take the full path.
    try {
      renameSync(mountDir, warmMount);
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return null;
  }

  perfMark('fast-launch: warm mount claimed');

  try {
    const child = spawn(plan.spawn.binPath, plan.spawn.args, {
      cwd: mountDir,
      stdio: 'inherit',
      env: Object.keys(plan.spawn.envAdditions).length > 0
        ? { ...process.env, ...plan.spawn.envAdditions }
        : process.env
    });
    perfMark('fast-launch: harness child spawning');
    return {
      plan,
      child,
      sessionRoot,
      mountDir,
      statePath,
      startedAt: Date.now()
    };
  } catch {
    // Spawn failed synchronously — return the mount so the warm cache
    // survives, then fall back to the full path.
    try {
      renameSync(statePath, warmState);
      renameSync(mountDir, warmMount);
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return null;
  }
}

/**
 * Persist a launch plan (0600 — it holds no secrets by construction, but
 * there's no reason to share it either). Written by the full launch path
 * after a successful session.
 */
export function writeLaunchPlan(plan: LaunchPlan): void {
  const path = launchPlanPath(plan.cwd, plan.selector);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

/** Remove a stale plan so the next launch takes the full path. */
export function deleteLaunchPlan(cwd: string, selector: string): void {
  try {
    rmSync(launchPlanPath(cwd, selector), { force: true });
  } catch {
    /* best effort */
  }
}
