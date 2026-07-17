#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

class InstallationError extends Error {}

// Top-level wrapper. Delegates to the @agentworkforce/cli entry point under the
// shorter `agentworkforce` bin name so users can `npm i -g agentworkforce` and
// run `agentworkforce agent <persona>`. The CLI derives its help-text bin name
// from process.argv[1], so this file's basename (sans extension) is what
// shows up in usage strings.
function readPackage(packageJson, label) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
  } catch {
    throw new InstallationError(`${label} package metadata is invalid.`);
  }
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new InstallationError(`Could not read ${label} package version.`);
  }
  return pkg;
}

function resolveCli() {
  const wrapperPackageJsonUrl = new URL('../package.json', import.meta.url);
  const wrapper = readPackage(
    wrapperPackageJsonUrl,
    'agentworkforce'
  );
  parseVersion(wrapper.version, 'agentworkforce wrapper');
  const project = resolveProjectInstall(
    fileURLToPath(wrapperPackageJsonUrl),
    wrapper.version
  );

  if (project) {
    if (project.wrapperVersion !== project.cli.version) {
      throw new InstallationError(
        [
          'project-local agentworkforce installation is inconsistent; refusing to run it.',
          `project wrapper version: ${project.wrapperVersion}`,
          `project @agentworkforce/cli version: ${project.cli.version}`,
          `Repair it with: npm install agentworkforce@${project.wrapperVersion}`
        ].join('\n')
      );
    }
    return { version: project.cli.version, entryUrl: project.cli.entryUrl };
  }

  // Only require the invoked wrapper's dependency after checking whether a
  // newer coherent project install wins. A partial global install must not
  // mask a complete, newer local candidate.
  const bundledRepair = `npm install -g agentworkforce@${wrapper.version}`;
  const bundled = readCliCandidate(
    resolveAssociatedCliPackageJson(
      require,
      'agentworkforce installation',
      bundledRepair
    ),
    'wrapper dependency',
    bundledRepair
  );

  if (wrapper.version !== bundled.version) {
    throw new InstallationError(
      [
        'agentworkforce installation is inconsistent; refusing to run a stale nested CLI.',
        `wrapper version: ${wrapper.version}`,
        `resolved @agentworkforce/cli version: ${bundled.version}`,
        `Repair it with: npm install -g agentworkforce@${wrapper.version}`
      ].join('\n')
    );
  }

  return {
    version: bundled.version,
    entryUrl: bundled.entryUrl
  };
}

function resolveProjectInstall(invokedWrapperPackageJsonPath, invokedWrapperVersion) {
  const projectRequire = createRequire(
    pathToFileURL(path.join(process.cwd(), '__agentworkforce_resolve__.cjs'))
  );
  let wrapperPackageJsonPath;
  try {
    wrapperPackageJsonPath = projectRequire.resolve('agentworkforce/package.json');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return undefined;
    throw new InstallationError(
      [
        'project-local agentworkforce package metadata cannot be inspected; refusing to run an unverified local installation.',
        'Repair it with: npm install agentworkforce'
      ].join('\n')
    );
  }

  if (path.resolve(wrapperPackageJsonPath) === path.resolve(invokedWrapperPackageJsonPath)) {
    return undefined;
  }

  const projectWrapper = readPackage(wrapperPackageJsonPath, 'project-local agentworkforce');
  // Validate candidate version syntax even when it would not win selection;
  // a broken local launcher must not be silently mistaken for an older one.
  parseVersion(projectWrapper.version, 'project-local agentworkforce');
  if (compareVersions(projectWrapper.version, invokedWrapperVersion) <= 0) {
    return undefined;
  }
  const localRequire = createRequire(pathToFileURL(wrapperPackageJsonPath));
  const repairCommand = `npm install agentworkforce@${projectWrapper.version}`;
  const cliPackageJsonPath = resolveAssociatedCliPackageJson(
    localRequire,
    'project-local agentworkforce installation',
    repairCommand
  );
  return {
    wrapperVersion: projectWrapper.version,
    cli: readCliCandidate(
      cliPackageJsonPath,
      'project-local wrapper dependency',
      repairCommand
    )
  };
}

function resolveAssociatedCliPackageJson(localRequire, installationLabel, repairCommand) {
  try {
    return localRequire.resolve('@agentworkforce/cli/package.json');
  } catch {
    throw new InstallationError(
      [
        `${installationLabel} has no resolvable @agentworkforce/cli metadata; refusing to run a partial or unverified installation.`,
        `Repair it with: ${repairCommand}`
      ].join('\n')
    );
  }
}

function readCliCandidate(packageJsonPath, source, repairCommand) {
  const pkg = readPackage(packageJsonPath, `@agentworkforce/cli ${source}`);
  parseVersion(pkg.version, `@agentworkforce/cli ${source}`);
  const entryUrl = new URL('./dist/cli.js', pathToFileURL(packageJsonPath));
  if (!existsSync(fileURLToPath(entryUrl))) {
    throw new InstallationError(
      [
        `@agentworkforce/cli ${source} has no executable entry; refusing to run a partial installation.`,
        `Repair it with: ${repairCommand}`
      ].join('\n')
    );
  }
  return {
    version: pkg.version,
    entryUrl: entryUrl.href
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] < b.numbers[i]) return -1;
    if (a.numbers[i] > b.numbers[i]) return 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(left, right) {
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) {
      const aNumber = BigInt(a[i]);
      const bNumber = BigInt(b[i]);
      if (aNumber < bNumber) return -1;
      if (aNumber > bNumber) return 1;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function parseVersion(version, label = 'package') {
  const identifier = '[0-9A-Za-z-]+';
  const match = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${identifier}(?:\\.${identifier})*))?` +
    `(?:\\+${identifier}(?:\\.${identifier})*)?$`
  ).exec(version);
  const prerelease = match?.[4] ?? '';
  const hasInvalidNumericIdentifier = prerelease
    .split('.')
    .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
  if (!match || hasInvalidNumericIdentifier) {
    throw new InstallationError(
      `${label} has an invalid semantic version: ${JSON.stringify(version)}`
    );
  }
  return {
    numbers: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease
  };
}

try {
  // Resolve and validate the implementation even for --version. Reporting the
  // wrapper version alone used to hide partially-updated installations where
  // this package was current but its nested CLI (and deploy stack) was stale.
  const cli = resolveCli();

  if (process.argv[2] === '-v' || process.argv[2] === '--version') {
    process.stdout.write(`${cli.version}\n`);
    process.exit(0);
  }

  // Import the entry from the exact package whose version was checked above;
  // do not ask the module resolver a second time and risk selecting a different
  // hoisted or nested copy.
  const { main } = await import(cli.entryUrl);
  await main();
} catch (err) {
  process.stderr.write(
    `${err instanceof InstallationError ? err.message : (err?.stack ?? String(err))}\n`
  );
  process.exit(1);
}
