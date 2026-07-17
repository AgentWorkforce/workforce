import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { build, type Metafile } from 'esbuild';
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
    const buildResult = await build({
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

    const bundleManifest = await buildBundleManifest(
      buildResult.metafile,
      bundlePath,
      onEventAbs,
      absWorkingDir
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
  absWorkingDir: string
): Promise<BundleManifest> {
  const expectedBundlePath = path.resolve(absWorkingDir, bundlePath);
  const output = Object.entries(metafile.outputs).find(
    ([outputPath]) => path.resolve(absWorkingDir, outputPath) === expectedBundlePath
  )?.[1];
  if (!output) {
    throw new Error('bundle: esbuild metafile did not describe agent.bundle.mjs');
  }

  const ownerCache = new Map<string, Promise<PackageOwnership | undefined>>();
  const entryOwner = await findPackageOwnership(entryPointPath, ownerCache);
  const contributingInputs = Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([inputPath]) => path.resolve(absWorkingDir, inputPath));
  const owners = await Promise.all(
    contributingInputs.map((inputPath) => findPackageOwnership(inputPath, ownerCache))
  );

  const uniquePackages = new Map<string, BundlePackageVersion>();
  for (const owner of owners) {
    if (!owner || owner.root === entryOwner?.root) continue;
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

async function findPackageOwnership(
  inputPath: string,
  cache: Map<string, Promise<PackageOwnership | undefined>>
): Promise<PackageOwnership | undefined> {
  let resolvedInput: string;
  try {
    resolvedInput = await realpath(inputPath);
  } catch {
    // Non-file esbuild inputs (for example virtual/plugin namespaces) do not
    // have package metadata and must never leak their identifiers as paths.
    return undefined;
  }
  return findPackageOwnershipFromDirectory(path.dirname(resolvedInput), cache);
}

function findPackageOwnershipFromDirectory(
  directory: string,
  cache: Map<string, Promise<PackageOwnership | undefined>>
): Promise<PackageOwnership | undefined> {
  const cached = cache.get(directory);
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
      if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
        return { root: directory, invalidMetadata: { field: '"name"' } };
      }
      if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
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
  cache.set(directory, pending);
  return pending;
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
