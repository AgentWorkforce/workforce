/**
 * Fix the GitHub publish.yml workflow in relayfile-adapters using the
 * npm-provenance persona.
 *
 * The current publish.yml uses NODE_AUTH_TOKEN / NPM_TOKEN secrets instead of
 * OIDC npm trusted publishing. This workflow uses the npm-provenance persona
 * to fix it.
 *
 * Run with:
 *   agent-relay run workflows/fix-relayfile-adapters-publish.ts
 */

import { usePersona } from '../packages/workload-router/dist/index.js';

const { execute } = usePersona('npm-provenance');

try {
  const result = await execute(
    'Fix the GitHub Actions publish workflow at .github/workflows/publish.yml to use OIDC npm trusted publishing instead of NODE_AUTH_TOKEN / NPM_TOKEN secrets. Requirements: (1) Remove all NODE_AUTH_TOKEN / NPM_TOKEN secret references — OIDC only. (2) Ensure job permissions include id-token: write and contents: read. (3) Ensure npm publish uses --provenance --access public. (4) Preserve the existing workflow_dispatch inputs (package, version, tag, dry_run) and the multi-package publishing loop. (5) Keep the version bump and git commit steps. Write the fixed file to disk — do not print to stdout.',
    {
      workingDirectory: '../relayfile-adapters',
      timeoutSeconds: 600,
    }
  );

  console.log('Result:', result.status);
} catch (err: unknown) {
  const error = err as Error & { result?: unknown };
  console.error('Execution failed:', error.message);
  if (error.result) {
    console.error('Result:', error.result);
  }
  process.exit(1);
}
