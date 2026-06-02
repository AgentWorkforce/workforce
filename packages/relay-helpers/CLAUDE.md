# CLAUDE.md — @agentworkforce/relay-helpers

See [AGENTS.md](./AGENTS.md) for the full notes.

**Key rule:** this package must export a named `<provider>Client` for every
provider in `@relayfile/adapter-core/writeback-paths`. The non-bespoke clients
are **generated** into `src/generated/clients.ts` (do not hand-edit). When you
bump `@relayfile/adapter-core` and a new provider appears, the in-sync test goes
red — run `pnpm --filter @agentworkforce/relay-helpers gen` to regenerate;
`index.ts` `export *`s it, so nothing else to edit. Never hardcode provider
paths here — resolve them through `writebackPath` / `relayClient` /
`providerClient`.
