import { build } from 'esbuild';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

export interface BundleInput {
  personaPath: string;
  persona: PersonaSpec;
  outDir: string;
  bundlerOptions?: { minify?: boolean };
}

export interface BundleResult {
  personaCopyPath: string;
  runnerPath: string;
  bundlePath: string;
  packageJsonPath: string;
  sizeBytes: number;
}

type DeployPersonaSpec = PersonaSpec & {
  // TODO(human): remove this intersection when PersonaSpec includes deploy fields.
  onEvent?: string;
};

const runnerTemplate = `import { startRunner } from '@agentworkforce/runtime/runner';
import persona from './persona.json' assert { type: 'json' };
import * as agentModule from './agent.bundle.mjs';
const handler = agentModule.default ?? agentModule.handler;
startRunner({ persona, handler });
`;

export async function stageBundle(input: BundleInput): Promise<BundleResult> {
  if (!isAbsolute(input.personaPath)) {
    throw new Error('personaPath must be absolute');
  }
  if (!isAbsolute(input.outDir)) {
    throw new Error('outDir must be absolute');
  }

  const persona = input.persona as DeployPersonaSpec;
  if (!persona.onEvent) {
    throw new Error('persona.onEvent is required to stage a deploy bundle');
  }

  const entryPath = resolve(dirname(input.personaPath), persona.onEvent);
  await assertFile(entryPath, `onEvent file does not exist: ${entryPath}`);

  await rm(input.outDir, { recursive: true, force: true });
  await mkdir(input.outDir, { recursive: true });

  const personaCopyPath = join(input.outDir, 'persona.json');
  const runnerPath = join(input.outDir, 'runner.mjs');
  const bundlePath = join(input.outDir, 'agent.bundle.mjs');
  const packageJsonPath = join(input.outDir, 'package.json');

  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    target: 'node20',
    format: 'esm',
    platform: 'node',
    sourcemap: 'inline',
    minify: input.bundlerOptions?.minify ?? false,
    external: ['node:*', '@agentworkforce/runtime/raw']
  });

  await writeFile(personaCopyPath, `${JSON.stringify(input.persona, null, 2)}\n`, 'utf8');
  await writeFile(runnerPath, runnerTemplate, 'utf8');
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        type: 'module',
        dependencies: { '@agentworkforce/runtime': await readWorkspacePackageVersion('@agentworkforce/runtime') }
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  return {
    personaCopyPath,
    runnerPath,
    bundlePath,
    packageJsonPath,
    sizeBytes: await directorySize(input.outDir)
  };
}

async function assertFile(path: string, message: string): Promise<void> {
  try {
    const file = await stat(path);
    if (file.isFile()) {
      return;
    }
  } catch {
    // fall through
  }
  throw new Error(message);
}

async function readWorkspacePackageVersion(packageName: string): Promise<string> {
  let current = resolve(process.cwd());
  let fallbackVersion: string | undefined;

  while (true) {
    const candidate = join(current, 'package.json');
    try {
      const contents = JSON.parse(await readFile(candidate, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof contents.version === 'string' && contents.version.length > 0) {
        fallbackVersion ??= contents.version;
        if (contents.name === packageName) {
          return contents.version;
        }
        if (await pathExists(join(current, 'pnpm-workspace.yaml'))) {
          const packageVersion = await findWorkspacePackageVersion(current, packageName);
          if (packageVersion) return packageVersion;
          return contents.version;
        }
      }
    } catch {
      // Keep walking toward the filesystem root.
    }

    const parent = dirname(current);
    if (parent === current) {
      if (fallbackVersion) {
        return fallbackVersion;
      }
      throw new Error('Could not find package.json with a version');
    }
    current = parent;
  }
}

async function findWorkspacePackageVersion(root: string, packageName: string): Promise<string | undefined> {
  const packagesDir = join(root, 'packages');
  if (!(await pathExists(packagesDir))) return undefined;
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageJson = join(packagesDir, entry.name, 'package.json');
    try {
      const contents = JSON.parse(await readFile(packageJson, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (contents.name === packageName && typeof contents.version === 'string') {
        return contents.version;
      }
    } catch {
      // Keep scanning other workspace packages.
    }
  }
  return undefined;
}

async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }

  return total;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
