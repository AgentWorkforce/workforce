#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Top-level wrapper. Delegates to the @agentworkforce/cli entry point under the
// shorter `agentworkforce` bin name so users can `npm i -g agentworkforce` and
// run `agentworkforce agent <persona>`. The CLI derives its help-text bin name
// from process.argv[1], so this file's basename (sans extension) is what
// shows up in usage strings.
function readPackageVersion() {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('Could not read agentworkforce package version.');
  }
  return pkg.version;
}

try {
  if (process.argv[2] === '-v' || process.argv[2] === '--version') {
    process.stdout.write(`${readPackageVersion()}\n`);
    process.exit(0);
  }

  const { main } = await import('@agentworkforce/cli/dist/cli.js');
  await main();
} catch (err) {
  process.stderr.write(`${err?.stack ?? String(err)}\n`);
  process.exit(1);
}
