# @agentworkforce/persona-nango-integrations

The canonical **nango-integrations** AgentWorkforce persona, published as a
**persona pack** so both `cloud` and `nightcto` install the same definition with
the workforce CLI instead of hand-maintaining divergent copies.

The persona builds and maintains Nango TypeScript integrations **and** their
Cloud-side Relayfile wiring (the `ADAPTERS` registry, webhook router, path
mapping, and digest tests) — an integration is not done until both sides land.

## Install

```bash
agentworkforce install @agentworkforce/persona-nango-integrations
# or, to refresh an existing copy:
agentworkforce install @agentworkforce/persona-nango-integrations --overwrite
```

The CLI copies `personas/nango-integrations.json` into the consumer's
`.agentworkforce/workforce/personas/` (the directory the persona loader scans).
`package.json` advertises the pack via:

```json
"agentworkforce": { "personas": "personas" }
```

The whole spec — including the operations manual on `agentsMdContent` — lives in
`personas/nango-integrations.json`. There are no external markdown sidecars.

## Programmatic usage

Existing consumers can still import the persona object directly:

```ts
import persona from '@agentworkforce/persona-nango-integrations';

console.log(persona.id); // nango-integrations
```

The legacy JSON subpath also resolves to the moved pack file:

```ts
import persona from '@agentworkforce/persona-nango-integrations/persona.json' with { type: 'json' };
```

## Source of truth

`personas/nango-integrations.json` is the single source of truth. To change the
persona, edit that file and republish; consumers re-run
`agentworkforce install … --overwrite` to pick up the new version.

## Publishing

Published under the `@agentworkforce` scope via the dedicated
`.github/workflows/publish-persona.yml` workflow (separate from the
`@relayfile/*` `publish.yml`), using npm `--provenance`.
