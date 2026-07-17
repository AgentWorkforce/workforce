import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';
import { parse as parseSemver } from 'semver';
import validatePackageName from 'validate-npm-package-name';
import type { BundleManifest, BundlePackageVersion } from '@agentworkforce/runtime/runner';
import type { BundleStageInput, BundleResult, BundleStager } from './types.js';

const require = createRequire(import.meta.url);

/**
 * Versioned identifier embedded in the generated runner so a future
 * bundle reader can detect format drift. Bumped whenever the runner
 * shape changes incompatibly.
 */
const RUNNER_FORMAT_VERSION = 3;

const NODE_EXTERNALS = [
  ...builtinModules,
  'node:*'
];
const NODE_EXTERNAL_SET = new Set(NODE_EXTERNALS);

/**
 * Stage a deploy-ready bundle to `input.outDir`. Output layout:
 *
 *   <outDir>/
 *     agent.bundle.mjs       — esbuilt user `onEvent` (default-exported handler)
 *     runner.mjs             — entry that imports the runtime + bundle + persona
 *     persona.json           — verbatim copy of the input persona spec
 *     package.json           — runtime pin + exact bundled-package manifest
 *
 * The bundle is idempotent: re-running with the same `outDir` overwrites
 * the four files cleanly. Auxiliary files left behind from earlier runs
 * are not touched (callers control the directory lifecycle).
 *
 * Externals: every bare and `node:` builtin and `@agentworkforce/runtime`
 * itself are left external so the runner can resolve them at execution time.
 * Bundling the runtime in would require shipping the runtime sources into
 * every sandbox; the chosen split keeps the bundle small and lets ops
 * patch the runtime without rebuilding every persona.
 */
export const bundleStager: BundleStager = {
  async stage(input: BundleStageInput): Promise<BundleResult> {
    await mkdir(input.outDir, { recursive: true });

    const onEventAbs = path.resolve(path.dirname(input.personaPath), input.persona.onEvent ?? '');
    if (!input.persona.onEvent) {
      throw new Error(
        `bundle: persona "${input.persona.id}" is missing onEvent (cannot stage a bundle without a handler)`
      );
    }
    await assertReadableFile(onEventAbs, `persona "${input.persona.id}" onEvent`);

    const bundlePath = path.join(input.outDir, 'agent.bundle.mjs');
    const runnerPath = path.join(input.outDir, 'runner.mjs');
    const personaCopyPath = path.join(input.outDir, 'persona.json');
    const packageJsonPath = path.join(input.outDir, 'package.json');

    const absWorkingDir = process.cwd();
    const dependencyTrace: DependencyTrace = {
      roots: new Map(),
      metadataFailures: new Map()
    };
    let buildResult;
    try {
      buildResult = await build({
        entryPoints: [onEventAbs],
        outfile: bundlePath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        sourcemap: 'inline',
        logLevel: 'silent',
        minify: input.bundlerOptions?.minify ?? false,
        metafile: true,
        absWorkingDir,
        plugins: [traceLogicalDependencyRoots(dependencyTrace)],
        banner: {
          js: [
            'import { createRequire as __agentworkforceCreateRequire } from "node:module";',
            'const require = __agentworkforceCreateRequire(import.meta.url);'
          ].join('\n')
        },
        // Resolve TypeScript / JS extensions without forcing the user to
        // write `.ts`-suffixed imports in their handler file.
        resolveExtensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json'],
        external: [
          // Runtime stays external — see file header comment.
          '@agentworkforce/runtime',
          '@agentworkforce/runtime/raw',
          // Node builtins must never be bundled.
          ...NODE_EXTERNALS
        ]
      });
    } catch (error) {
      const failure = [...dependencyTrace.metadataFailures.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      )[0];
      if (failure) throw invalidBundledPackageMetadataError(failure[0], failure[1]);
      throw error;
    }

    const bundleManifest = await buildBundleManifest(
      buildResult.metafile,
      bundlePath,
      onEventAbs,
      absWorkingDir,
      dependencyTrace.roots
    );

    await writeFile(personaCopyPath, JSON.stringify(input.persona, null, 2) + '\n', 'utf8');

    await writeFile(
      packageJsonPath,
      buildPackageJson(input.persona.id, resolveRuntimeVersion(), bundleManifest),
      'utf8'
    );

    await writeFile(runnerPath, renderRunner(), 'utf8');

    const bundleStat = await stat(bundlePath);
    const runnerStat = await stat(runnerPath);
    const sizeBytes = bundleStat.size + runnerStat.size;

    return {
      personaCopyPath,
      runnerPath,
      bundlePath,
      packageJsonPath,
      sizeBytes
    };
  }
};

/**
 * Resolve the exact `@agentworkforce/runtime` version this copy of
 * `@agentworkforce/deploy` was built against, by reading the installed
 * package's own `package.json`. In a published install this is the exact
 * version `workspace:*` was pinned to at publish time (see
 * `packages/deploy/package.json`'s own dependency); in the monorepo it's
 * whatever's checked out locally. Either way it's the version the CLI
 * actually knows how to talk to — never a wildcard the sandbox's npm
 * install could silently satisfy with a stale cached/pre-baked copy.
 */
function resolveRuntimeVersion(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('@agentworkforce/runtime/package.json');
  } catch (err) {
    throw new Error(
      `bundle: could not resolve @agentworkforce/runtime/package.json to pin an exact version (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  const pkg = require(packageJsonPath) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`bundle: ${packageJsonPath} has no valid "version" field`);
  }
  return pkg.version;
}

function buildPackageJson(
  personaId: string,
  runtimeVersion: string,
  bundleManifest: BundleManifest
): string {
  return (
    JSON.stringify(
      {
        name: `@agentworkforce/deployed-${personaId}`,
        private: true,
        version: '0.0.0',
        type: 'module',
        main: './runner.mjs',
        dependencies: {
          '@agentworkforce/runtime': runtimeVersion
        },
        bundleManifest,
        comment:
          'Generated by workforce deploy. The runtime dep is pinned to the exact version this deploy CLI was built against so the sandbox installs the same runtime the bundle was compiled for, instead of trusting whatever is pre-baked or cached. bundleManifest records exact versions whose package inputs contributed bytes to agent.bundle.mjs.'
      },
      null,
      2
    ) + '\n'
  );
}

function renderRunner(): string {
  return `// Generated by @agentworkforce/deploy. Format version ${RUNNER_FORMAT_VERSION}.
// Do not edit by hand — \`workforce deploy\` overwrites this file on every stage.
//
// The runner imports the user's handler from the esbuilt bundle, the
// parsed persona spec from the verbatim JSON copy, and the runtime's
// \`startRunner\` to drive the dispatch loop. Envelopes arrive on stdin
// as NDJSON; structured logs go to stdout.

import { createRequire } from 'node:module';
import { startRunner } from '@agentworkforce/runtime/runner';
import { handler as wrapHandler } from '@agentworkforce/runtime';
import * as userModule from './agent.bundle.mjs';

const require = createRequire(import.meta.url);
const persona = require('./persona.json');
const packageJson = require('./package.json');
const bundleManifest = packageJson.bundleManifest;

// The agent.ts default export is a \`defineAgent({...})\` object carrying the
// handler plus the listener declarations. A bare function default export is
// accepted as a legacy fallback (treated as the handler with no listeners).
const exported = userModule.default ?? userModule.handler;
let candidate;
let agentSpec;
if (exported && exported.__workforceAgent) {
  candidate = exported.handler;
  agentSpec = {
    ...(exported.launchedBy !== undefined ? { launchedBy: exported.launchedBy } : {}),
    ...(exported.triggers ? { triggers: exported.triggers } : {}),
    ...(exported.schedules ? { schedules: exported.schedules } : {}),
    ...(exported.watch ? { watch: exported.watch } : {})
  };
} else if (exported && typeof exported.handler === 'function') {
  candidate = exported.handler;
  agentSpec = {
    ...(exported.launchedBy !== undefined ? { launchedBy: exported.launchedBy } : {}),
    ...(exported.triggers ? { triggers: exported.triggers } : {}),
    ...(exported.schedules ? { schedules: exported.schedules } : {}),
    ...(exported.watch ? { watch: exported.watch } : {})
  };
} else {
  candidate = exported;
}
if (typeof candidate !== 'function') {
  throw new TypeError(
    \`workforce deploy bundle: \${persona.id} did not default-export defineAgent({ ..., handler }). Did you forget \\\`export default defineAgent(...)\\\`?\`
  );
}
const handler = candidate.__workforceHandler ? candidate : wrapHandler(candidate);

const agent = readRuntimeContext('WORKFORCE_AGENT_CONTEXT');
const deployment = readRuntimeContext('WORKFORCE_DEPLOYMENT_CONTEXT');

await startRunner({ persona, agent, deployment, handler, bundleManifest, ...(agentSpec ? { agentSpec } : {}) });

function readRuntimeContext(name) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(\`workforce deploy bundle: missing \${name}; the deploy launcher must inject runtime row context\`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      \`workforce deploy bundle: \${name} must be valid JSON: \${err instanceof Error ? err.message : String(err)}\`
    );
  }
}
`;
}

async function buildBundleManifest(
  metafile: Metafile,
  bundlePath: string,
  entryPointPath: string,
  absWorkingDir: string,
  dependencyRoots: Map<string, Set<string>>
): Promise<BundleManifest> {
  const expectedBundlePath = path.resolve(absWorkingDir, bundlePath);
  const output = Object.entries(metafile.outputs).find(
    ([outputPath]) => path.resolve(absWorkingDir, outputPath) === expectedBundlePath
  )?.[1];
  if (!output) {
    throw new Error('bundle: esbuild metafile did not describe agent.bundle.mjs');
  }

  const ownerCache: PackageOwnershipCache = {
    directories: new Map(),
    packageRoots: new Map()
  };
  const entryOwner = await findPackageOwnership(entryPointPath, ownerCache, dependencyRoots);
  const contributingInputs = Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([inputPath]) => path.resolve(absWorkingDir, inputPath));
  const owners = await Promise.all(
    contributingInputs.map((inputPath) =>
      findPackageOwnership(inputPath, ownerCache, dependencyRoots)
    )
  );

  const uniquePackages = new Map<string, BundlePackageVersion>();
  for (const owner of owners) {
    if (!owner) continue;
    // The entry owner is the author/consumer package, not a bundled
    // dependency. Identify it by the canonical ownership root before
    // validating publishable dependency metadata: private applications may
    // legitimately omit a version or use workspace-only package metadata.
    if (owner.root === entryOwner?.root) continue;
    if (owner.invalidMetadata) {
      const packageLabel = owner.invalidMetadata.name
        ? ` package "${owner.invalidMetadata.name}"`
        : ' dependency package';
      throw new Error(
        `bundle: bundled${packageLabel} has no valid ${owner.invalidMetadata.field} metadata`
      );
    }
    if (!owner.pkg) continue;
    const key = `${owner.pkg.name}\u0000${owner.pkg.version}`;
    uniquePackages.set(key, owner.pkg);
  }

  return {
    schemaVersion: 1,
    packages: [...uniquePackages.values()].sort(comparePackageVersions)
  };
}

interface PackageOwnership {
  root: string;
  pkg?: BundlePackageVersion;
  invalidMetadata?: {
    name?: string;
    field: 'package.json' | '"name"' | '"version"';
  };
}

interface PackageOwnershipCache {
  directories: Map<string, Promise<PackageOwnership | undefined>>;
  packageRoots: Map<string, Promise<PackageRootMetadata>>;
}

interface PackageRootMetadata {
  pkg?: BundlePackageVersion;
  invalidField?: 'package.json' | '"name"' | '"version"';
}

interface LogicalDependencyBoundary {
  name: string;
  root: string;
}

interface DependencyTrace {
  roots: Map<string, Set<string>>;
  metadataFailures: Map<string, 'package.json' | '"name"' | '"version"'>;
}

async function findPackageOwnership(
  inputPath: string,
  cache: PackageOwnershipCache,
  dependencyRoots: Map<string, Set<string>>
): Promise<PackageOwnership | undefined> {
  // Capture a logical node_modules package boundary whenever esbuild retains
  // one. Symlinked inputs are normally already dereferenced in the metafile;
  // those are recovered from the resolution trace below.
  const dependencyBoundary = findLogicalDependencyBoundary(inputPath);
  if (dependencyBoundary) {
    return findDependencyPackageOwnership(dependencyBoundary, cache);
  }

  let resolvedInput: string;
  try {
    resolvedInput = await realpath(inputPath);
  } catch {
    // Non-file esbuild inputs (for example virtual/plugin namespaces) do not
    // have package metadata and must never leak their identifiers as paths.
    return undefined;
  }
  const tracedBoundary = findTracedDependencyBoundary(resolvedInput, dependencyRoots);
  if (tracedBoundary) {
    return findDependencyPackageOwnership(tracedBoundary, cache);
  }
  return findPackageOwnershipFromDirectory(path.dirname(resolvedInput), cache);
}

async function findDependencyPackageOwnership(
  boundary: LogicalDependencyBoundary,
  cache: PackageOwnershipCache
): Promise<PackageOwnership> {
  let realRoot: string;
  try {
    realRoot = await realpath(boundary.root);
  } catch {
    return {
      root: boundary.root,
      invalidMetadata: { name: boundary.name, field: 'package.json' }
    };
  }

  let metadata = cache.packageRoots.get(realRoot);
  if (!metadata) {
    metadata = readPackageRootMetadata(realRoot);
    cache.packageRoots.set(realRoot, metadata);
  }
  const resolved = await metadata;
  if (resolved.pkg) return { root: realRoot, pkg: resolved.pkg };
  return {
    root: realRoot,
    invalidMetadata: {
      // Use only the stable logical dependency name in errors. Never expose
      // the consumer path, workspace target, or an unrelated ancestor label.
      name: boundary.name,
      field: resolved.invalidField ?? 'package.json'
    }
  };
}

async function readPackageRootMetadata(directory: string): Promise<PackageRootMetadata> {
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return { invalidField: 'package.json' };
  }
  if (!isValidPackageName(parsed.name)) {
    return { invalidField: '"name"' };
  }
  if (!isExactPackageVersion(parsed.version)) {
    return { invalidField: '"version"' };
  }
  return { pkg: { name: parsed.name, version: parsed.version } };
}

function isValidPackageName(value: unknown): value is string {
  return typeof value === 'string' && validatePackageName(value).validForNewPackages;
}

function isExactPackageVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = parseSemver(value);
  if (!parsed) return false;

  // node-semver deliberately accepts compatibility spellings such as a
  // leading "v" or surrounding whitespace. Reconstruct the canonical SemVer
  // spelling so package metadata remains an exact version, while retaining
  // valid prerelease and build identifiers.
  const prerelease = parsed.prerelease.length > 0
    ? `-${parsed.prerelease.map(String).join('.')}`
    : '';
  const build = parsed.build.length > 0 ? `+${parsed.build.join('.')}` : '';
  return value === `${parsed.major}.${parsed.minor}.${parsed.patch}${prerelease}${build}`;
}

function findPackageOwnershipFromDirectory(
  directory: string,
  cache: PackageOwnershipCache
): Promise<PackageOwnership | undefined> {
  const cached = cache.directories.get(directory);
  if (cached) return cached;

  const pending = (async (): Promise<PackageOwnership | undefined> => {
    // Do not attribute a versionless package under node_modules to the
    // consumer package above that node_modules boundary.
    if (path.basename(directory) === 'node_modules') return undefined;

    const packageJsonPath = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (!isValidPackageName(parsed.name)) {
        return { root: directory, invalidMetadata: { field: '"name"' } };
      }
      if (!isExactPackageVersion(parsed.version)) {
        return {
          root: directory,
          invalidMetadata: { name: parsed.name, field: '"version"' }
        };
      }
      return { root: directory, pkg: { name: parsed.name, version: parsed.version } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Never claim an ancestor's version when the nearest metadata is
        // unreadable or malformed.
        return { root: directory, invalidMetadata: { field: 'package.json' } };
      }
    }

    const inferredPackageName = packageNameAtNodeModulesBoundary(directory);
    if (inferredPackageName) {
      return {
        root: directory,
        invalidMetadata: { name: inferredPackageName, field: 'package.json' }
      };
    }

    const parent = path.dirname(directory);
    return parent === directory
      ? undefined
      : findPackageOwnershipFromDirectory(parent, cache);
  })();
  cache.directories.set(directory, pending);
  return pending;
}

function findLogicalDependencyBoundary(inputPath: string): LogicalDependencyBoundary | undefined {
  let directory = path.dirname(path.resolve(inputPath));
  while (true) {
    const name = packageNameAtNodeModulesBoundary(directory);
    if (name) return { name, root: directory };
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function findTracedDependencyBoundary(
  inputPath: string,
  dependencyRoots: Map<string, Set<string>>
): LogicalDependencyBoundary | undefined {
  let match: LogicalDependencyBoundary | undefined;
  for (const [root, names] of dependencyRoots) {
    if (!isPathInside(inputPath, root) || (match && match.root.length >= root.length)) continue;
    const name = [...names].sort()[0];
    if (name) match = { name, root };
  }
  return match;
}

/**
 * esbuild intentionally resolves symlinks to their real targets before the
 * metafile is produced. Trace bare-package resolutions without changing that
 * behavior, so pnpm's realpath-based dependency lookup keeps working while the
 * manifest builder retains the logical package boundary and stable name.
 */
function traceLogicalDependencyRoots(trace: DependencyTrace): Plugin {
  const recursiveResolve = {};
  const metadataCache = new Map<string, Promise<PackageRootMetadata>>();
  return {
    name: 'agentworkforce-logical-dependency-roots',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === recursiveResolve) return undefined;
        const packageName = packageNameFromBareSpecifier(args.path);
        if (!packageName || isExternalPackageSpecifier(args.path)) return undefined;

        const nearestRoot = await findNearestInstalledPackageRoot(args.resolveDir, packageName);
        const result = await buildApi.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: recursiveResolve,
          with: args.with
        });
        const root = nearestRoot && (
          (!result.external && path.isAbsolute(result.path) && isPathInside(result.path, nearestRoot))
          || result.errors.length > 0
        ) ? nearestRoot : undefined;
        if (root) {
          let metadata = metadataCache.get(root);
          if (!metadata) {
            metadata = readPackageRootMetadata(root);
            metadataCache.set(root, metadata);
          }
          const resolvedMetadata = await metadata;
          if (result.errors.length > 0 && resolvedMetadata.invalidField) {
            trace.metadataFailures.set(packageName, resolvedMetadata.invalidField);
            return { errors: [{ text: 'bundled dependency metadata validation failed' }] };
          }
          if (!result.external && path.isAbsolute(result.path)) {
            const names = trace.roots.get(root) ?? new Set<string>();
            names.add(packageName);
            trace.roots.set(root, names);
          }
        }
        return result;
      });
    }
  };
}

async function findNearestInstalledPackageRoot(
  resolveDirectory: string,
  packageName: string
): Promise<string | undefined> {
  let directory = path.resolve(resolveDirectory);
  while (true) {
    const logicalRoot = path.join(directory, 'node_modules', ...packageName.split('/'));
    try {
      return await realpath(logicalRoot);
    } catch {
      // This resolution level does not contain the requested package.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function invalidBundledPackageMetadataError(
  packageName: string,
  field: 'package.json' | '"name"' | '"version"'
): Error {
  return new Error(`bundle: bundled package "${packageName}" has no valid ${field} metadata`);
}

function packageNameFromBareSpecifier(specifier: string): string | undefined {
  if (
    specifier.length === 0
    || specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('#')
    || specifier.includes('\\')
  ) {
    return undefined;
  }
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 && segments[0].length > 1 && segments[1].length > 0
      ? `${segments[0]}/${segments[1]}`
      : undefined;
  }
  return segments[0] || undefined;
}

function isExternalPackageSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:')
    || NODE_EXTERNAL_SET.has(specifier)
    || specifier === '@agentworkforce/runtime'
    || specifier === '@agentworkforce/runtime/raw';
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function packageNameAtNodeModulesBoundary(directory: string): string | undefined {
  const parent = path.dirname(directory);
  if (path.basename(parent) === 'node_modules') return path.basename(directory);
  const grandparent = path.dirname(parent);
  return path.basename(grandparent) === 'node_modules' && path.basename(parent).startsWith('@')
    ? `${path.basename(parent)}/${path.basename(directory)}`
    : undefined;
}

function comparePackageVersions(a: BundlePackageVersion, b: BundlePackageVersion): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.version < b.version) return -1;
  if (a.version > b.version) return 1;
  return 0;
}

async function assertReadableFile(abs: string, label: string): Promise<void> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      throw new Error(`${label}: ${abs} is not a regular file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}: file not found at ${abs}`);
    }
    throw err;
  }
}
