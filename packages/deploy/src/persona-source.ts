import { randomUUID } from 'node:crypto';
import { builtinModules } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, type Loader, type Plugin } from 'esbuild';

const NODE_EXTERNALS = [
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

const RESOLVE_EXTENSIONS = [
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

function packageNodePaths(absInput: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(dirname(absInput), 'node_modules'),
    join(here, '..', 'node_modules'),
    join(here, '..', '..', '..', 'node_modules'),
    join(process.cwd(), 'node_modules')
  ];
}

function preserveLocalImportMetaUrlPlugin(): Plugin {
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

function extractDefaultExport(value: unknown): unknown {
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
