# relay-helpers — agent notes

## Invariant: a named client for every catalog provider

This package MUST expose a named `<provider>Client` for **every** provider in
`@relayfile/adapter-core/writeback-paths` (`WRITEBACK_PATH_CATALOG`). The test
**"every catalog provider has a named client export"** (`src/relay-helpers.test.ts`)
fails CI until it does — so this can't silently drift.

When `@relayfile/adapter-core` is bumped and a new provider appears (a new
writeback-capable adapter shipped upstream in `relayfile-adapters`), the build
goes red. To fix it:

1. Add a named export to `src/clients.ts`:
   ```ts
   export const fooClient = (opts?: IntegrationClientOptions): ProviderClient<'foo'> =>
     providerClient('foo', opts);
   ```
   camelCase any hyphens in the provider slug (`azure-blob` → `azureBlobClient`).
2. Re-export it from `src/index.ts`.
3. If the provider deserves ergonomic named methods (like `linear`/`github`/`slack`
   with `comment`/`post`/`mergePullRequest`), add a bespoke module that
   *enriches* `providerClient(...)` via `Object.assign` instead of the plain
   one-liner — but watch for a method name that collides with a catalog resource
   key (that's why github's merge helper is `mergePullRequest`, not `merge`).
4. `pnpm --filter @agentworkforce/relay-helpers test` must pass.

## Paths are never hardcoded here

Every path comes from the catalog via `writebackPath` / `relayClient` /
`providerClient`. Do not write `/linear/issues/...` literals — that reintroduces
the drift this package exists to prevent. If a path is wrong, fix it in the
adapter's `resources.ts` upstream (relayfile-adapters), regenerate the catalog,
and bump the dep.

The upstream obligation (an adapter author noticing a new provider lands here)
is documented in `relayfile-adapters/AGENTS.md` → "Declared catalogs".
