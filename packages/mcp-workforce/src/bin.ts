#!/usr/bin/env node
import { runStdioServer } from './server.js';

runStdioServer().catch((err: unknown) => {
  process.stderr.write(
    `[workforce-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
