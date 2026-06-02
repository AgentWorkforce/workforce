# CLAUDE.md — @agentworkforce/relay-helpers

See [AGENTS.md](./AGENTS.md) for the full notes.

**Key rule:** this package must export a named `<provider>Client` for every
provider in `@relayfile/adapter-core/writeback-paths`. The test "every catalog
provider has a named client export" enforces it. When you bump
`@relayfile/adapter-core` and a new provider appears, add it to `src/clients.ts`
(and re-export from `src/index.ts`). Never hardcode provider paths here — resolve
them through `writebackPath` / `relayClient` / `providerClient`.
