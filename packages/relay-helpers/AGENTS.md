# relay-helpers — agent notes

## Invariant: a named client for every catalog provider

This package MUST expose a named `<provider>Client` for **every** provider in
`@relayfile/adapter-core/writeback-paths` (`WRITEBACK_PATH_CATALOG`). The test
**"every catalog provider has a named client export"** (`src/relay-helpers.test.ts`)
fails CI until it does — so this can't silently drift.

The named clients for the plain providers are **generated** — `src/generated/clients.ts`
is emitted by `scripts/generate-clients.mjs` from the catalog. Do not hand-edit
it. When `@relayfile/adapter-core` is bumped and a new provider appears (a new
writeback-capable adapter shipped upstream in `relayfile-adapters`), the in-sync
test goes red. To fix it:

1. Regenerate:
   ```bash
   pnpm --filter @agentworkforce/relay-helpers gen
   ```
   This adds the new `<provider>Client` (camelCased slug — `azure-blob` →
   `azureBlobClient`) to `src/generated/clients.ts`. `index.ts` does
   `export *` from it, so no re-export edit is needed.
2. If the provider deserves ergonomic named methods (like `linear`/`github`/`slack`
   with `comment`/`post`/`mergePullRequest`), add it to `BESPOKE_PROVIDERS` in
   the generator and write a bespoke module that *enriches* `providerClient(...)`
   via `Object.assign` — but watch for a method name that collides with a catalog
   resource key (that's why github's merge helper is `mergePullRequest`, not
   `merge`).
3. `pnpm --filter @agentworkforce/relay-helpers test` must pass.

## Paths are never hardcoded here

Every path comes from the catalog via `writebackPath` / `relayClient` /
`providerClient`. Do not write `/linear/issues/...` literals — that reintroduces
the drift this package exists to prevent. If a path is wrong, fix it in the
adapter's `resources.ts` upstream (relayfile-adapters), regenerate the catalog,
and bump the dep.

The upstream obligation (an adapter author noticing a new provider lands here)
is documented in `relayfile-adapters/AGENTS.md` → "Declared catalogs".
