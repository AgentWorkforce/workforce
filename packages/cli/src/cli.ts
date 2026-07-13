#!/usr/bin/env node
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Thin CLI entry. Loading the full CLI module graph costs hundreds of
 * milliseconds, so `agent <persona>` first tries the warm fast path — plan
 * validation + warm-mount claim + harness spawn via `fast-launch.js` (node
 * builtins only) — and only then imports the heavy implementation, either to
 * manage the already-running fast session or to run the full launch.
 *
 * Everything that used to live in this file is in `cli-impl.js`; this entry
 * must stay import-free apart from node builtins or the fast path is
 * pointless.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'agent' && process.env.AGENTWORKFORCE_NO_FAST !== '1') {
    const { tryFastAgentLaunch } = await import('./fast-launch.js');
    const fast = tryFastAgentLaunch(argv.slice(1));
    if (fast) {
      const { resumeFastSession } = await import('./cli-impl.js');
      await resumeFastSession(fast);
      return;
    }
  }
  const { main: fullMain } = await import('./cli-impl.js');
  await fullMain();
}

// Only run main when invoked as the CLI entry, not when imported by tests.
// Node ESM: import.meta.url is the module URL; argv[1] is the entry script
// path, which may be relative (e.g. `node ./dist/cli.js`) and pathToFileURL
// throws on relative paths. Resolve to absolute first.
const isCliEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(entry)).href;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch(async (err) => {
    const { MissingPersonaInputError } = await import('@agentworkforce/persona-kit');
    if (err instanceof MissingPersonaInputError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  });
}
