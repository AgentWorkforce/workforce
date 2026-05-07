import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve as resolvePath
} from 'node:path';
import { homedir, tmpdir } from 'node:os';

export interface PersonaInstallOptions {
  source: string;
  cwd?: string;
  overwrite?: boolean;
  personaIds?: readonly string[];
  resolveNpmPackage?: (spec: string, tempDir: string) => string;
}

export interface InstalledPersona {
  id: string;
  sourcePath: string;
  targetPath: string;
  fileName: string;
}

export interface PersonaInstallConflict {
  id: string;
  targetPath: string;
  fileName: string;
}

export interface PersonaInstallResult {
  source: string;
  packageRoot: string;
  personaDir: string;
  targetDir: string;
  installed: InstalledPersona[];
  conflicts: PersonaInstallConflict[];
}

interface PackageJsonShape {
  agentworkforce?: {
    personas?: unknown;
  };
}

interface PersonaFile {
  id: string;
  sourcePath: string;
  fileName: string;
  targetPath: string;
}

export function projectPersonaInstallDir(cwd = process.cwd()): string {
  return join(cwd, '.agentworkforce', 'workforce', 'personas');
}

export function isLocalInstallSource(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.startsWith('.') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    trimmed === '~' ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\')
  );
}

export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

function resolveLocalSource(source: string, cwd: string): string {
  const expanded = expandHomePath(source);
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(cwd, expanded);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertDirectory(path: string, context: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch (err) {
    throw new Error(`${context}: ${(err as Error).message}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${context}: path is not a directory: ${path}`);
  }
}

function readPackageJson(packageRoot: string): PackageJsonShape | undefined {
  const path = join(packageRoot, 'package.json');
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`install: could not read ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`install: ${path} must be a JSON object`);
  }
  return parsed as PackageJsonShape;
}

function resolvePackageRelativeDir(packageRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error('install: package.json agentworkforce.personas must be a relative path');
  }
  const normalized = normalize(relPath);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('install: package.json agentworkforce.personas must not contain ".."');
  }
  const resolved = resolvePath(packageRoot, normalized);
  const fromRoot = relative(packageRoot, resolved);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('install: package.json agentworkforce.personas must stay inside the package');
  }
  return resolved;
}

function resolvePersonaDir(packageRoot: string): string {
  const pkg = readPackageJson(packageRoot);
  let personaRelPath = 'personas';
  if (pkg?.agentworkforce !== undefined) {
    if (!isPlainObject(pkg.agentworkforce)) {
      throw new Error('install: package.json agentworkforce must be an object if provided');
    }
    if (pkg.agentworkforce.personas !== undefined) {
      if (
        typeof pkg.agentworkforce.personas !== 'string' ||
        !pkg.agentworkforce.personas.trim()
      ) {
        throw new Error(
          'install: package.json agentworkforce.personas must be a non-empty string'
        );
      }
      personaRelPath = pkg.agentworkforce.personas;
    }
  }
  const personaDir = resolvePackageRelativeDir(packageRoot, personaRelPath);
  assertDirectory(personaDir, 'install: persona directory');
  return personaDir;
}

function collectJsonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

function readPersonaId(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`install: could not read persona ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`install: persona ${path} must be a JSON object`);
  }
  const id = parsed.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`install: persona ${path} must declare a non-empty string id`);
  }
  return id;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function collectPersonas(personaDir: string, targetDir: string): PersonaFile[] {
  const jsonFiles = collectJsonFiles(personaDir);
  if (jsonFiles.length === 0) {
    throw new Error(`install: no persona JSON files found in ${personaDir}`);
  }

  const byId = new Map<string, string>();
  const byFileName = new Map<string, string>();
  const personas: PersonaFile[] = [];
  for (const sourcePath of jsonFiles) {
    const id = readPersonaId(sourcePath);
    const existingIdPath = byId.get(id);
    if (existingIdPath) {
      throw new Error(
        `install: package contains duplicate persona id "${id}" in ${existingIdPath} and ${sourcePath}`
      );
    }
    byId.set(id, sourcePath);

    const fileName = basename(sourcePath);
    const existingFilePath = byFileName.get(fileName);
    if (existingFilePath) {
      throw new Error(
        `install: multiple persona files flatten to ${fileName}: ${existingFilePath} and ${sourcePath}`
      );
    }
    byFileName.set(fileName, sourcePath);
    personas.push({
      id,
      sourcePath,
      fileName,
      targetPath: join(targetDir, fileName)
    });
  }
  return personas;
}

function resolveRequestedPersonas(
  personas: readonly PersonaFile[],
  requestedIds: readonly string[]
): PersonaFile[] {
  if (requestedIds.length === 0) return [...personas];
  const requested = dedupe(requestedIds);
  const byId = new Map(personas.map((persona) => [persona.id, persona] as const));
  const missing = requested.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`install: persona id(s) not found in package: ${missing.join(', ')}`);
  }
  return requested.map((id) => byId.get(id)!);
}

function parseNpmPackStdout(stdout: string, packDir: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && isPlainObject(parsed[0])) {
      const filename = parsed[0].filename;
      if (typeof filename === 'string' && filename.trim()) {
        return isAbsolute(filename) ? filename : join(packDir, filename);
      }
    }
  } catch {
    // Fall back to scanning the pack destination below.
  }
  const lastLine = trimmed.split(/\r?\n/).filter(Boolean).at(-1);
  if (!lastLine) return undefined;
  return isAbsolute(lastLine) ? lastLine : join(packDir, lastLine);
}

export function npmExecutable(platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function defaultResolveNpmPackage(spec: string, tempDir: string): string {
  const packDir = join(tempDir, 'pack');
  const unpackDir = join(tempDir, 'unpack');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(unpackDir, { recursive: true });

  const packed = spawnSync(
    npmExecutable(),
    ['pack', spec, '--pack-destination', packDir, '--json', '--ignore-scripts'],
    { encoding: 'utf8', shell: false }
  );
  if (packed.status !== 0) {
    const detail =
      String(packed.stderr ?? '').trim() ||
      String(packed.stdout ?? '').trim() ||
      packed.error?.message ||
      `exit ${packed.status ?? 'unknown'}`;
    throw new Error(`install: npm pack failed for ${spec}: ${detail}`);
  }

  const tarballFromStdout = parseNpmPackStdout(String(packed.stdout ?? ''), packDir);
  const tarball =
    tarballFromStdout && existsSync(tarballFromStdout)
      ? tarballFromStdout
      : readdirSync(packDir)
          .filter((name) => name.endsWith('.tgz'))
          .map((name) => join(packDir, name))[0];
  if (!tarball) {
    throw new Error(`install: npm pack did not produce a .tgz for ${spec}`);
  }

  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', unpackDir], {
    encoding: 'utf8',
    shell: false
  });
  if (extracted.status !== 0) {
    const detail =
      String(extracted.stderr ?? '').trim() ||
      String(extracted.stdout ?? '').trim() ||
      extracted.error?.message ||
      `exit ${extracted.status ?? 'unknown'}`;
    throw new Error(`install: could not unpack ${tarball}: ${detail}`);
  }
  return join(unpackDir, 'package');
}

export function installPersonas(options: PersonaInstallOptions): PersonaInstallResult {
  const cwd = options.cwd ?? process.cwd();
  const source = options.source.trim();
  if (!source) throw new Error('install: missing package or local path.');

  const targetDir = projectPersonaInstallDir(cwd);
  let tempDir: string | undefined;
  let packageRoot: string;
  try {
    if (isLocalInstallSource(source)) {
      packageRoot = resolveLocalSource(source, cwd);
      assertDirectory(packageRoot, 'install: local source');
    } else {
      tempDir = mkdtempSync(join(tmpdir(), 'agentworkforce-install-'));
      const resolver = options.resolveNpmPackage ?? defaultResolveNpmPackage;
      packageRoot = resolver(source, tempDir);
      assertDirectory(packageRoot, 'install: npm package');
    }

    const personaDir = resolvePersonaDir(packageRoot);
    const personas = collectPersonas(personaDir, targetDir);
    const selected = resolveRequestedPersonas(personas, options.personaIds ?? []);
    mkdirSync(targetDir, { recursive: true });

    const installed: InstalledPersona[] = [];
    const conflicts: PersonaInstallConflict[] = [];
    for (const persona of selected) {
      if (existsSync(persona.targetPath) && options.overwrite !== true) {
        conflicts.push({
          id: persona.id,
          targetPath: persona.targetPath,
          fileName: persona.fileName
        });
        continue;
      }
      copyFileSync(persona.sourcePath, persona.targetPath);
      installed.push(persona);
    }

    return {
      source,
      packageRoot,
      personaDir,
      targetDir,
      installed,
      conflicts
    };
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
