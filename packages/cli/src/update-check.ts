/**
 * `agentworkforce --version` update check.
 *
 * Printing a bare version number tells you what you have but not whether it is
 * current, so `--version` also asks the npm registry for the published
 * `latest` and — when the installed build is behind it — prints the upgrade
 * command to stderr. stderr keeps `$(agentworkforce --version)` parsable in
 * scripts while the notice still reaches a human at a terminal.
 *
 * The check is strictly best-effort: an offline machine, a private registry
 * that does not carry the package, a slow proxy, or a malformed response all
 * resolve to "no notice". Nothing in this module may throw or delay `--version`
 * beyond the timeout, so every failure path is swallowed.
 *
 * This module is imported from the `agentworkforce` wrapper bin as well as from
 * `cli-impl`, so it must stay free of non-builtin imports.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package users install, and therefore the one whose `latest` we report. */
export const UPDATE_CHECK_PACKAGE = 'agentworkforce';

/** Registry used when neither agentworkforce nor npm config names one. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Registry budget for the whole check. `--version` must stay near-instant. */
export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 1500;

/** Where the running CLI was resolved from; decides whether to suggest `-g`. */
export type InstallScope = 'global' | 'project';

type ParsedVersion = {
  numbers: [bigint, bigint, bigint];
  prerelease: string;
};

export type UpdateNoticeOptions = {
  /** Install location of the CLI being run. Inferred from `moduleUrl` if omitted. */
  scope?: InstallScope;
  /** Module whose location decides the scope. Defaults to this module. */
  moduleUrl?: string;
  /** Working directory a project-local install would be resolved against. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Strict semver parse. Returns `undefined` instead of throwing: an unparsable
 * version (a git build, a registry typo) means "cannot compare", not "fail".
 */
export function parseVersion(version: unknown): ParsedVersion | undefined {
  if (typeof version !== 'string' || !version) return undefined;
  const identifier = '[0-9A-Za-z-]+';
  const match = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
      `(?:-(${identifier}(?:\\.${identifier})*))?` +
      `(?:\\+${identifier}(?:\\.${identifier})*)?$`
  ).exec(version);
  if (!match) return undefined;
  const prerelease = match[4] ?? '';
  const hasInvalidNumericIdentifier = prerelease
    .split('.')
    .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
  if (hasInvalidNumericIdentifier) return undefined;
  return {
    numbers: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease
  };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const aPart = a[i];
    const bPart = b[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) {
      const aNumber = BigInt(aPart);
      const bNumber = BigInt(bPart);
      if (aNumber < bNumber) return -1;
      if (aNumber > bNumber) return 1;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

/**
 * Semver ordering, `undefined` when either side is unparsable. Mirrors the
 * comparator the wrapper bin uses to pick between installs, including
 * "a prerelease sorts below its own release".
 */
export function compareVersions(left: unknown, right: unknown): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] < b.numbers[i]) return -1;
    if (a.numbers[i] > b.numbers[i]) return 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Opt-out. `AGENTWORKFORCE_NO_UPDATE_CHECK=1` is ours; `NO_UPDATE_NOTIFIER=1`
 * is the ecosystem-wide convention and images that set it mean it for us too.
 */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTWORKFORCE_NO_UPDATE_CHECK === '1' || env.NO_UPDATE_NOTIFIER === '1';
}

/**
 * Registry to query: our override first, then whatever npm was configured with
 * (`npm_config_registry` is exported into `npm run`/`npx` environments), then
 * the public registry. A non-http(s) value is ignored rather than fetched.
 */
export function resolveRegistryBase(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [env.AGENTWORKFORCE_REGISTRY, env.npm_config_registry]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    return parsed.href.replace(/\/+$/, '');
  }
  return DEFAULT_REGISTRY;
}

/** Timeout budget, overridable for slow private registries. */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTWORKFORCE_UPDATE_CHECK_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return parsed > 0 ? parsed : DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
}

/**
 * Read the `latest` dist-tag. The dist-tags endpoint is a few dozen bytes,
 * unlike the full packument, which is megabytes for a package with our release
 * cadence.
 */
export async function fetchLatestVersion(options: {
  registry?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<string | undefined> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;

  const controller = new AbortController();
  // Cleared in `finally`, so a fast response never waits out the budget.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${registry}/-/package/${UPDATE_CHECK_PACKAGE}/dist-tags`,
      {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        redirect: 'follow'
      }
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object') return undefined;
    const latest = (body as { latest?: unknown }).latest;
    return parseVersion(latest) ? (latest as string) : undefined;
  } catch {
    // Offline, DNS failure, timeout, 4xx from a private registry, non-JSON
    // body: all mean "no answer", never "break --version".
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A CLI resolved from `<cwd>/node_modules` was installed as a project
 * dependency, so `-g` would update a different copy than the one that just ran.
 */
export function resolveInstallScope(
  moduleUrl: string = import.meta.url,
  cwd: string = process.cwd()
): InstallScope {
  let modulePath: string;
  try {
    modulePath = path.resolve(fileURLToPath(moduleUrl));
  } catch {
    return 'global';
  }
  const projectModules = path.resolve(cwd, 'node_modules') + path.sep;
  return modulePath.startsWith(projectModules) ? 'project' : 'global';
}

/** The command that replaces the running install with the published latest. */
export function resolveUpdateCommand(scope: InstallScope): string {
  return scope === 'project'
    ? `npm install ${UPDATE_CHECK_PACKAGE}@latest`
    : `npm install -g ${UPDATE_CHECK_PACKAGE}@latest`;
}

/** The two-line notice; kept short so it does not bury the version itself. */
export function formatUpdateNotice(
  current: string,
  latest: string,
  scope: InstallScope = 'global'
): string {
  return [
    `Update available: ${current} → ${latest}`,
    `Run \`${resolveUpdateCommand(scope)}\` to update.`,
    ''
  ].join('\n');
}

/**
 * The notice for this install, or `undefined` when the check is disabled, the
 * registry is unreachable, or the running build is already current (or ahead of
 * `latest`, as an unreleased local build is).
 */
export async function resolveUpdateNotice(
  currentVersion: string,
  options: UpdateNoticeOptions = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (isUpdateCheckDisabled(env)) return undefined;
  if (!parseVersion(currentVersion)) return undefined;

  const latest = await fetchLatestVersion({
    registry: resolveRegistryBase(env),
    timeoutMs: resolveTimeoutMs(env),
    fetchImpl: options.fetchImpl
  });
  if (!latest) return undefined;
  if ((compareVersions(currentVersion, latest) ?? 0) >= 0) return undefined;

  const scope =
    options.scope ?? resolveInstallScope(options.moduleUrl ?? import.meta.url, options.cwd);
  return formatUpdateNotice(currentVersion, latest, scope);
}

/**
 * Emit the notice on stderr, if there is one. Callers can `await` this without
 * a try/catch: it resolves quietly on every failure.
 */
export async function writeUpdateNotice(
  currentVersion: string,
  options: UpdateNoticeOptions & { write?: (text: string) => void } = {}
): Promise<void> {
  try {
    const notice = await resolveUpdateNotice(currentVersion, options);
    if (!notice) return;
    const write = options.write ?? ((text: string) => process.stderr.write(text));
    write(notice);
  } catch {
    // An update notice is never worth a non-zero exit from `--version`.
  }
}
