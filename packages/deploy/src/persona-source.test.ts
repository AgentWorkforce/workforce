import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { nodeModulesChain, packageNodePaths, withUnresolvedImportHint } from './persona-source.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('nodeModulesChain treats an ancestor node_modules as a search root', () => {
  const chain = nodeModulesChain('/prefix/node_modules/@agentworkforce/deploy/dist');
  assert.ok(
    chain.includes('/prefix/node_modules'),
    `installed tree root missing from ${JSON.stringify(chain)}`
  );
  assert.ok(
    !chain.some((dir) => dir.endsWith('node_modules/node_modules')),
    `doubled node_modules segment in ${JSON.stringify(chain)}`
  );
});

test('packageNodePaths searches the persona tree before the CLI tree', () => {
  const paths = packageNodePaths('/repo/customer-success/app-signal/persona.ts');
  assert.equal(paths[0], path.join('/repo/customer-success/app-signal', 'node_modules'));
  assert.equal(new Set(paths).size, paths.length, 'duplicate entries');
  assert.ok(
    paths.includes(nodeModulesChain(HERE).find((dir) => dir.endsWith('node_modules')) as string),
    'this package install root missing'
  );
});

test('withUnresolvedImportHint names the missing package and where to install it', () => {
  const hinted = withUnresolvedImportHint(
    new Error(
      'Build failed with 1 error:\npersona.ts:2:30: ERROR: Could not resolve "@agentworkforce/turn-kit"'
    ),
    '/repo/customer-success/app-signal/persona.ts'
  );
  assert.ok(hinted instanceof Error);
  assert.match(hinted.message, /npm install @agentworkforce\/turn-kit/);
  assert.match(hinted.message, /\/repo\/customer-success\/app-signal/);
});

test('withUnresolvedImportHint installs the package, not the deep import path', () => {
  const hinted = withUnresolvedImportHint(
    new Error(
      [
        'ERROR: Could not resolve "@relayfile/adapter-core/triggers"',
        'ERROR: Could not resolve "lodash/fp"'
      ].join('\n')
    ),
    '/repo/persona.ts'
  ) as Error;
  assert.match(hinted.message, /npm install @relayfile\/adapter-core lodash$/m);
});

test('withUnresolvedImportHint quotes shell metacharacters', () => {
  const hinted = withUnresolvedImportHint(
    new Error(String.raw`ERROR: Could not resolve "evil; touch pwned"`),
    "/repo/it's a dir/persona.ts"
  ) as Error;
  const command = hinted.message.split('\n').at(-1) as string;
  assert.equal(command, String.raw`  cd '/repo/it'\''s a dir' && npm install 'evil; touch pwned'`);
  // Round-trip through a shell to prove the injected command cannot run.
  assert.deepEqual(
    execFileSync('/bin/sh', ['-c', `set -- ${command.trim().split('npm install ')[1]}; printf '%s' "$1"`], {
      encoding: 'utf8'
    }),
    'evil; touch pwned'
  );
});

test('withUnresolvedImportHint ignores relative imports', () => {
  const message = 'ERROR: Could not resolve "./missing.js"';
  const hinted = withUnresolvedImportHint(new Error(message), '/repo/persona.ts');
  assert.equal((hinted as Error).message, message);
});

/**
 * The shipped failure: a globally installed CLI compiling a persona in a repo
 * that has no `node_modules`. Reproduced by copying the built package into an
 * installed layout so `import.meta.url` inside persona-source resolves the way
 * it does for a real `npm i -g agentworkforce`.
 */
test('authored persona resolves a CLI-tree package with no project node_modules', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentworkforce-install-'));
  const originalCwd = process.cwd();
  try {
    const installRoot = path.join(root, 'prefix', 'node_modules');
    const deployDir = path.join(installRoot, '@agentworkforce', 'deploy');
    await mkdir(deployDir, { recursive: true });
    await cp(HERE, path.join(deployDir, 'dist'), { recursive: true });
    await writeFile(
      path.join(deployDir, 'package.json'),
      JSON.stringify({ name: '@agentworkforce/deploy', type: 'module' }),
      'utf8'
    );
    // esbuild is a real dependency of the copied package; link it into the
    // fake tree so the copy can load at all.
    await symlink(
      path.dirname(require.resolve('esbuild/package.json')),
      path.join(installRoot, 'esbuild')
    );

    const kitDir = path.join(installRoot, '@agentworkforce', 'persona-kit');
    await mkdir(kitDir, { recursive: true });
    await writeFile(
      path.join(kitDir, 'package.json'),
      JSON.stringify({ name: '@agentworkforce/persona-kit', type: 'module', main: 'index.js' }),
      'utf8'
    );
    await writeFile(
      path.join(kitDir, 'index.js'),
      'export function definePersona(input) { return input; }\n',
      'utf8'
    );

    // The persona lives outside the install tree and has no node_modules.
    const personaDir = path.join(root, 'watchdog-agents', 'customer-success', 'app-signal');
    await mkdir(personaDir, { recursive: true });
    const personaPath = path.join(personaDir, 'persona.ts');
    await writeFile(
      personaPath,
      [
        "import { definePersona } from '@agentworkforce/persona-kit';",
        '',
        "export default definePersona({ id: 'app-signal', onEvent: './agent.ts' });",
        ''
      ].join('\n'),
      'utf8'
    );

    const installed = (await import(
      pathToFileURL(path.join(deployDir, 'dist', 'persona-source.js')).href
    )) as typeof import('./persona-source.js');

    // The user's cwd is their own repo, which has no node_modules either —
    // without this the test's cwd (this monorepo) resolves the import and the
    // assertion holds even against the broken implementation.
    process.chdir(personaDir);
    const result = await installed.loadPersonaSourceFile(personaPath);
    assert.deepEqual(result.persona, { id: 'app-signal', onEvent: './agent.ts' });
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
