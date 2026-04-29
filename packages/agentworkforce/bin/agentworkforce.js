#!/usr/bin/env node
// Top-level wrapper. Re-exports the @agentworkforce/cli entry point under the
// shorter `agentworkforce` bin name so users can `npm i -g agentworkforce` and
// run `agentworkforce agent <persona>`. The CLI derives its help-text bin name
// from process.argv[1], so this file's basename (sans extension) is what
// shows up in usage strings.
import { main } from '@agentworkforce/cli/dist/cli.js';

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
