# @agentworkforce/persona-autonomous-actor

The canonical **autonomous-actor** AgentWorkforce persona, published as a
**persona pack** so consumers install the same definition with the workforce CLI
instead of hand-maintaining divergent copies.

The persona is an autonomous orchestrator for delegated, multi-PR, multi-day,
**cutover-class** infra/feature delivery. It operates under an explicit written
contract that grants (per a defined bar) auto-merge authority, flip-the-switch
authority, swarm-blockers authority, and pre-authorized rollback — while holding
standing constraints (no manual prod deploy; no direct prod SQL;
instrument-don't-guess after two failed fixes; serialize merges through green
main) and named escalate-to-human conditions.

## Install

```bash
agentworkforce install @agentworkforce/persona-autonomous-actor
# or, to refresh an existing copy:
agentworkforce install @agentworkforce/persona-autonomous-actor --overwrite
```

The CLI copies `personas/autonomous-actor.json` into the consumer's
`.agentworkforce/workforce/personas/` (the directory the persona loader scans).
`package.json` advertises the pack via:

```json
"agentworkforce": { "personas": "personas" }
```

The whole spec — including the operations manual on `claudeMdContent` — lives in
`personas/autonomous-actor.json`. There are no external markdown sidecars.

## Skills

The persona pulls its six operating skills from the published `@agent-relay`
collection (not repo-local file paths), so a launch never hard-fails on a
missing sidecar:

- `@agent-relay/autonomous-run-contract`
- `@agent-relay/auto-merge-and-composition-safety`
- `@agent-relay/dormant-flip-and-rollback`
- `@agent-relay/swarm-blockers-and-gate-scoreboard`
- `@agent-relay/tiered-acceptance`
- `@agent-relay/instrument-dont-guess`

Those skills are published as the **private** `autonomous-run-private` prpm
collection (see the repo-root `prpm.json`).

## Programmatic usage

```ts
import persona from '@agentworkforce/persona-autonomous-actor';

console.log(persona.id); // autonomous-actor
```

## Publishing

Published via the `Publish Persona Package` GitHub workflow
(`.github/workflows/publish-persona.yml`) using npm **provenance** (trusted
publishing). The workflow publishes all `@agentworkforce/persona-*` packs by
default, or a single one via the `package` input.
