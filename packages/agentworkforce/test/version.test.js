import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const binPath = fileURLToPath(new URL('../bin/agentworkforce.js', import.meta.url));

async function runBin(targetBinPath, args, options = {}) {
  const child = spawn(process.execPath, [targetBinPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout += buf.toString();
  });
  child.stderr.on('data', (buf) => {
    stderr += buf.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', resolve);
  });
  return { exitCode, stdout, stderr };
}

test('agentworkforce --version prints the implementation version it validated', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: pkg.version,
    cliVersion: pkg.version
  });
  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['--version'],
    { cwd: fixture.root }
  );
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, `${pkg.version}\n`);
});

test('refuses to execute a stale nested CLI and reports both resolved versions', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.25'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['deploy', 'persona.ts'],
    { cwd: fixture.root }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /refusing to run a stale nested CLI/);
  assert.match(stderr, /wrapper version: 4\.1\.26/);
  assert.match(stderr, /resolved @agentworkforce\/cli version: 4\.1\.25/);
  assert.match(stderr, /npm install -g agentworkforce@4\.1\.26/);
  assert.doesNotMatch(stderr, /WRAPPER CLI 4\.1\.25 EXECUTED/);
  assert.doesNotMatch(stderr, new RegExp(escapeRegExp(fixture.root)));
});

test('reports a sanitized repair command when the nested CLI package is missing', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    omitCliPackage: true
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['deploy', 'persona.ts'],
    { cwd: fixture.root }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /has no associated @agentworkforce\/cli/);
  assert.match(stderr, /refusing to run a partial installation/);
  assert.match(stderr, /npm install -g agentworkforce@4\.1\.26/);
  assert.doesNotMatch(stderr, /MODULE_NOT_FOUND/);
  assert.doesNotMatch(stderr, new RegExp(escapeRegExp(fixture.root)));
});

test('reports a sanitized repair command when the nested CLI entry is missing', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.26',
    omitCliEntry: true
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['deploy', 'persona.ts'],
    { cwd: fixture.root }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /has no executable entry/);
  assert.match(stderr, /refusing to run a partial installation/);
  assert.match(stderr, /npm install -g agentworkforce@4\.1\.26/);
  assert.doesNotMatch(stderr, new RegExp(escapeRegExp(fixture.root)));
});

test('a newer coherent project install wins over a partial invoked install', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.25',
    omitCliPackage: true,
    projectWrapperVersion: '4.1.26',
    projectCliVersion: '4.1.26',
    projectCliLayout: 'hoisted'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['deploy', 'persona.ts'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'PROJECT CLI 4.1.26 EXECUTED\n');
});

test('selects a newer coherent project install instead of the stale invoked install', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.25',
    cliVersion: '4.1.25',
    projectWrapperVersion: '4.1.26',
    projectCliVersion: '4.1.26',
    projectCliLayout: 'hoisted'
  });
  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'PROJECT CLI 4.1.26 EXECUTED\n');
  assert.doesNotMatch(stdout, /WRAPPER CLI 4\.1\.25 EXECUTED/);
});

test('compares multi-digit semantic version components numerically', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.9',
    cliVersion: '4.1.9',
    projectWrapperVersion: '4.1.10',
    projectCliVersion: '4.1.10'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'PROJECT CLI 4.1.10 EXECUTED\n');
});

test('never executes a bare cwd-local CLI without a coherent local wrapper', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.26',
    bareProjectCliVersion: '999.0.0'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'WRAPPER CLI 4.1.26 EXECUTED\n');
  assert.doesNotMatch(stdout, /BARE PROJECT CLI EXECUTED/);
});

test('fails closed when the newer project wrapper and its CLI are skewed', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.25',
    cliVersion: '4.1.25',
    projectWrapperVersion: '4.1.27',
    projectCliVersion: '4.1.26'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /project-local agentworkforce installation is inconsistent/);
  assert.match(stderr, /project wrapper version: 4\.1\.27/);
  assert.match(stderr, /project @agentworkforce\/cli version: 4\.1\.26/);
  assert.doesNotMatch(stderr, /WRAPPER CLI|PROJECT CLI/);
});

test('fails closed on an invalid project wrapper version without leaking its path', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.26',
    projectWrapperVersion: 'latest',
    projectCliVersion: '4.1.27'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /project-local agentworkforce has an invalid semantic version: "latest"/);
  assert.doesNotMatch(stderr, new RegExp(escapeRegExp(fixture.projectRoot)));
  assert.doesNotMatch(stderr, /WRAPPER CLI|PROJECT CLI/);
});

test('rejects semantic versions with leading-zero numeric identifiers', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.26',
    projectWrapperVersion: '4.1.027',
    projectCliVersion: '4.1.27'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /invalid semantic version: "4\.1\.027"/);
  assert.doesNotMatch(stderr, /WRAPPER CLI|PROJECT CLI/);
});

test('stable invoked versions outrank older project prereleases', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.10',
    cliVersion: '4.1.10',
    projectWrapperVersion: '4.1.10-rc.2',
    projectCliVersion: '4.1.10-rc.2'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.projectRoot }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'WRAPPER CLI 4.1.10 EXECUTED\n');
});

test('imports a matched nested CLI from an install path containing spaces', async (t) => {
  const fixture = await createInstalledTree(t, {
    wrapperVersion: '4.1.26',
    cliVersion: '4.1.26'
  });

  const { exitCode, stdout, stderr } = await runBin(
    fixture.binPath,
    ['agent', 'persona'],
    { cwd: fixture.root }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'WRAPPER CLI 4.1.26 EXECUTED\n');
});

async function createInstalledTree(t, {
  wrapperVersion,
  cliVersion,
  projectWrapperVersion,
  projectCliVersion,
  projectCliLayout,
  bareProjectCliVersion,
  omitCliPackage,
  omitCliEntry
}) {
  const tempParent = await mkdtemp(path.join(os.tmpdir(), 'agentworkforce install '));
  const root = path.join(tempParent, 'global tree');
  await mkdir(root, { recursive: true });
  t.after(async () => {
    await rm(tempParent, { recursive: true, force: true });
  });

  const wrapperRoot = path.join(root, 'lib', 'node_modules', 'agentworkforce');
  const fixtureBinPath = path.join(wrapperRoot, 'bin', 'agentworkforce.js');
  const cliRoot = path.join(wrapperRoot, 'node_modules', '@agentworkforce', 'cli');
  await mkdir(path.dirname(fixtureBinPath), { recursive: true });
  await cp(binPath, fixtureBinPath);
  await chmod(fixtureBinPath, 0o755);
  await writeFile(
    path.join(wrapperRoot, 'package.json'),
    JSON.stringify({ name: 'agentworkforce', version: wrapperVersion, type: 'module' })
  );
  if (!omitCliPackage) {
    await mkdir(path.join(cliRoot, 'dist'), { recursive: true });
    await writeFile(
      path.join(cliRoot, 'package.json'),
      JSON.stringify({ name: '@agentworkforce/cli', version: cliVersion, type: 'module' })
    );
    if (!omitCliEntry) {
      await writeFile(
        path.join(cliRoot, 'dist', 'cli.js'),
        `export async function main() { process.stdout.write(${JSON.stringify(
          `WRAPPER CLI ${cliVersion} EXECUTED\n`
        )}); }\n`
      );
    }
  }

  const projectRoot = path.join(tempParent, 'project tree');
  if (projectWrapperVersion) {
    const projectWrapperRoot = path.join(projectRoot, 'node_modules', 'agentworkforce');
    const projectCliRoot = projectCliLayout === 'hoisted'
      ? path.join(projectRoot, 'node_modules', '@agentworkforce', 'cli')
      : path.join(
        projectWrapperRoot,
        'node_modules',
        '@agentworkforce',
        'cli'
      );
    await mkdir(projectWrapperRoot, { recursive: true });
    await mkdir(path.join(projectCliRoot, 'dist'), { recursive: true });
    await writeFile(
      path.join(projectWrapperRoot, 'package.json'),
      JSON.stringify({
        name: 'agentworkforce',
        version: projectWrapperVersion,
        type: 'module'
      })
    );
    await writeFile(
      path.join(projectCliRoot, 'package.json'),
      JSON.stringify({
        name: '@agentworkforce/cli',
        version: projectCliVersion,
        type: 'module'
      })
    );
    await writeFile(
      path.join(projectCliRoot, 'dist', 'cli.js'),
      `export async function main() { process.stdout.write(${JSON.stringify(
        `PROJECT CLI ${projectCliVersion} EXECUTED\n`
      )}); }\n`
    );
  } else if (bareProjectCliVersion) {
    const projectCliRoot = path.join(projectRoot, 'node_modules', '@agentworkforce', 'cli');
    await mkdir(path.join(projectCliRoot, 'dist'), { recursive: true });
    await writeFile(
      path.join(projectCliRoot, 'package.json'),
      JSON.stringify({
        name: '@agentworkforce/cli',
        version: bareProjectCliVersion,
        type: 'module'
      })
    );
    await writeFile(
      path.join(projectCliRoot, 'dist', 'cli.js'),
      'export async function main() { process.stdout.write("BARE PROJECT CLI EXECUTED\\n"); }\n'
    );
  } else {
    await mkdir(projectRoot, { recursive: true });
  }

  return { root, projectRoot, binPath: fixtureBinPath };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
