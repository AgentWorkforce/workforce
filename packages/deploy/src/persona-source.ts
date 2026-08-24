import { randomUUID } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, type Loader, type Plugin } from 'esbuild';

export const NODE_EXTERNALS = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'node:*'
];

const PERSONA_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

export const RESOLVE_EXTENSIONS = [
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json'
];

export interface PersonaSourceLoadResult {
  inputPath: string;
  persona: unknown;
}

export function isPersonaSourcePath(inputPath: string): boolean {
  return PERSONA_SOURCE_EXTENSIONS.has(extensionOf(inputPath));
}

export async function loadPersonaSourceFile(
  inputPath: string
): Promise<PersonaSourceLoadResult> {
  const absInput = resolve(inputPath);
  await assertReadableFile(absInput, 'persona source input');

  const tempDir = await mkdtemp(join(tmpdir(), 'agentworkforce-persona-'));
  const compiledPath = join(tempDir, `${randomUUID()}.mjs`);

  try {
    await build({
      entryPoints: [absInput],
      outfile: compiledPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'silent',
      banner: {
        js: [
          'import { createRequire as __agentworkforceCreateRequire } from "node:module";',
          'const require = __agentworkforceCreateRequire(import.meta.url);'
        ].join('\n')
      },
      external: NODE_EXTERNALS,
      resolveExtensions: RESOLVE_EXTENSIONS,
      plugins: [preserveLocalImportMetaUrlPlugin()],
      nodePaths: packageNodePaths(absInput)
    }).catch((err) => {
      throw withUnresolvedImportHint(err, absInput);
    });

    const mod = await import(pathToFileURL(compiledPath).href);
    return {
      inputPath: absInput,
      persona: extractDefaultExport(mod.default)
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function assertReadableFile(abs: string, label: string): Promise<void> {
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

function extensionOf(inputPath: string): string {
  const normalized = inputPath.toLowerCase();
  const idx = normalized.lastIndexOf('.');
  return idx === -1 ? '' : normalized.slice(idx);
}

/**
 * esbuild `nodePaths` fallbacks for compiling authored `.ts`/`.js` personas
 * and agents.
 *
 * An authored persona lives in the user's own repo, which on a fresh install
 * usually has no `node_modules` at all — the CLI is installed globally, so
 * `@agentworkforce/*` exists only inside the CLI's own install tree. esbuild
 * resolves bare imports by walking up from the importer, so without these
 * fallbacks `import { definePersona } from '@agentworkforce/persona-kit'`
 * fails with "Could not resolve".
 *
 * Fallbacks are the full `node_modules` lookup chains of (in order) the
 * persona file, this module (the installed `@agentworkforce/deploy`), and the
 * cwd. The chain is computed the way Node's own resolver does it, including
 * the case a naive `join(dir, 'node_modules')` gets wrong: when an ancestor
 * *is* `node_modules`, that directory is itself the search root. Missing that
 * produced `<prefix>/node_modules/node_modules` — a path that only exists in
 * a monorepo checkout, which is why every installed CLI failed here while the
 * dev layout worked.
 *
 * Order matters: the persona's own dependencies win over the CLI's copies,
 * and every entry is only consulted after normal resolution has failed.
 */
export function packageNodePaths(absInput: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const root of [dirname(resolve(absInput)), here, process.cwd()]) {
    for (const dir of nodeModulesChain(root)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      paths.push(dir);
    }
  }
  return paths;
}

/** Every `node_modules` directory Node would search from `fromDir` upward. */
export function nodeModulesChain(fromDir: string): string[] {
  const chain: string[] = [];
  let dir = resolve(fromDir);
  for (;;) {
    chain.push(basename(dir) === 'node_modules' ? dir : join(dir, 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

/**
 * Turn esbuild's bare "Could not resolve" into an actionable install hint.
 *
 * After `packageNodePaths`, an `@agentworkforce/*` import the CLI ships
 * resolves on its own; what reaches here is a package neither the project nor
 * the CLI has (a persona kit the CLI does not depend on, a third-party SDK the
 * handler imports). Naming it plus the directory to install it in is the
 * difference between a dead end and a one-line fix.
 */
export function withUnresolvedImportHint(error: unknown, absInput: string): unknown {
  if (!(error instanceof Error)) return error;
  const missing = unresolvedSpecifiers(error.message);
  if (missing.length === 0) return error;

  const projectDir = dirname(resolve(absInput));
  error.message = [
    error.message,
    `Install the missing package${missing.length > 1 ? 's' : ''} where the persona lives:`,
    `  cd ${projectDir} && npm install ${missing.join(' ')}`
  ].join('\n');
  return error;
}

function unresolvedSpecifiers(message: string): string[] {
  const found = new Set<string>();
  for (const match of message.matchAll(/Could not resolve "([^"]+)"/g)) {
    const specifier = match[1];
    // Relative/absolute imports are authoring mistakes, not missing installs.
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    found.add(specifier);
  }
  return [...found];
}

export function preserveLocalImportMetaUrlPlugin(): Plugin {
  return {
    name: 'agentworkforce-preserve-local-import-meta-url',
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (args.path.split(/[/\\]/).includes('node_modules')) {
          return undefined;
        }

        const contents = await readFile(args.path, 'utf8');
        return {
          contents: rewriteModuleLocationReferences(contents, {
            dirname: dirname(args.path),
            filename: args.path,
            importMetaUrl: pathToFileURL(args.path).href
          }),
          loader: loaderForPath(args.path)
        };
      });
    }
  };
}

function loaderForPath(inputPath: string): Loader {
  switch (extensionOf(inputPath)) {
    case '.tsx':
      return 'tsx';
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    default:
      return 'js';
  }
}

function rewriteModuleLocationReferences(
  source: string,
  location: { dirname: string; filename: string; importMetaUrl: string }
): string {
  const replacements = [
    ['import.meta.url', JSON.stringify(location.importMetaUrl)],
    ['__dirname', JSON.stringify(location.dirname)],
    ['__filename', JSON.stringify(location.filename)]
  ] as const;
  let output = '';
  let i = 0;
  let state:
    | 'normal'
    | 'single'
    | 'double'
    | 'template'
    | 'template-expr'
    | 'template-expr-single'
    | 'template-expr-double'
    | 'template-expr-template'
    | 'line-comment'
    | 'block-comment' = 'normal';
  let commentReturnState: 'normal' | 'template-expr' = 'normal';
  let templateExprDepth = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'normal') {
      const replacement = replacements.find(([token]) => matchesToken(source, i, token));
      if (replacement) {
        output += replacement[1];
        i += replacement[0].length;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
        output += ch;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        commentReturnState = 'normal';
        output += ch + next;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        commentReturnState = 'normal';
        output += ch + next;
        i += 2;
        continue;
      }
    } else if (state === 'single' || state === 'double') {
      output += ch;
      if (ch === '\\') {
        output += next ?? '';
        i += next ? 2 : 1;
        continue;
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"')
      ) {
        state = 'normal';
      }
      i += 1;
      continue;
    } else if (state === 'template') {
      output += ch;
      if (ch === '\\') {
        output += next ?? '';
        i += next ? 2 : 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        output += next;
        state = 'template-expr';
        templateExprDepth = 1;
        i += 2;
        continue;
      }
      if (ch === '`') {
        state = 'normal';
      }
      i += 1;
      continue;
    } else if (state === 'template-expr') {
      const replacement = replacements.find(([token]) => matchesToken(source, i, token));
      if (replacement) {
        output += replacement[1];
        i += replacement[0].length;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'"
          ? 'template-expr-single'
          : ch === '"'
            ? 'template-expr-double'
            : 'template-expr-template';
        output += ch;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        commentReturnState = 'template-expr';
        output += ch + next;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        commentReturnState = 'template-expr';
        output += ch + next;
        i += 2;
        continue;
      }
      output += ch;
      if (ch === '{') {
        templateExprDepth += 1;
      } else if (ch === '}') {
        templateExprDepth -= 1;
        if (templateExprDepth === 0) {
          state = 'template';
        }
      }
      i += 1;
      continue;
    } else if (
      state === 'template-expr-single' ||
      state === 'template-expr-double' ||
      state === 'template-expr-template'
    ) {
      output += ch;
      if (ch === '\\') {
        output += next ?? '';
        i += next ? 2 : 1;
        continue;
      }
      if (
        (state === 'template-expr-single' && ch === "'") ||
        (state === 'template-expr-double' && ch === '"') ||
        (state === 'template-expr-template' && ch === '`')
      ) {
        state = 'template-expr';
      }
      i += 1;
      continue;
    } else if (state === 'line-comment') {
      output += ch;
      if (ch === '\n') {
        state = commentReturnState;
      }
      i += 1;
      continue;
    } else if (state === 'block-comment') {
      output += ch;
      if (ch === '*' && next === '/') {
        output += next;
        state = commentReturnState;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    output += ch;
    i += 1;
  }

  return output;
}

function matchesToken(source: string, index: number, token: string): boolean {
  if (!source.startsWith(token, index)) {
    return false;
  }
  const before = index > 0 ? source[index - 1] : '';
  const after = source[index + token.length] ?? '';
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

export function extractDefaultExport(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !('id' in value) &&
    'default' in value
  ) {
    return (value as { default: unknown }).default;
  }
  return value;
}
