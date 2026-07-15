# Workforce installed-layout local-preview repair

- Date: 2026-07-16
- Commit: `79fa07a22ad9daa79f48b8f43cc1039aebf1f55f`

## Scope

Repaired the local-preview worker root/permission strategy in `@agentworkforce/runtime` so installed-package execution stages under the invocation workspace instead of deriving a pseudo-workspace from `@agentworkforce/runtime/dist`. Added premature-worker stderr diagnostics with redaction, and added regression coverage that imports a copied runtime package from a temp consumer `node_modules` layout.

## Files changed

- `packages/runtime/src/local-preview.ts`
- `packages/runtime/src/local-preview.test.ts`

## Verification

Passed:

1. `mise exec node@26.3.1 -- pnpm --filter @agentworkforce/runtime test`
2. `mise exec node@26.3.1 -- pnpm --dir packages/cli exec tsc -p tsconfig.json`
3. `mise exec node@26.3.1 -- node --test dist/invoke-command.test.js` (run from `packages/cli`)
4. `mise exec node@26.3.1 -- pnpm build`
5. Installed-package smoke:
   - packed `@agentworkforce/runtime`
   - installed the tarball into a temp consumer project
   - ran `executeLocalRun()` from the installed package against a simple local-preview bundle
   - observed `{"exitCode":0,"status":"succeeded"}`

## Notes

- The permission allowlist now stages under `process.cwd()/.workforce` and grants only:
  - the staged bundle/stage roots,
  - the runtime package root/runtime dist root,
  - dependency roots implied by the runtime package layout (consumer/global `node_modules`, monorepo `packages` + root `node_modules` when applicable).
- Premature worker exits now include redacted child stderr so `ERR_ACCESS_DENIED` failures are actionable.
