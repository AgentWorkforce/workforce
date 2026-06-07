# @agentworkforce/persona-slack-comms

The **slack-comms** AgentWorkforce persona, published as a **persona pack** so
consumers install the same definition with the workforce CLI instead of
hand-maintaining divergent copies.

The persona is a **comms-only** Slack liaison for a multi-agent engineering
team. It owns every human-facing Slack message for the project's channel via
relayfile writeback, relays human messages to the engineering agent team over
agent-relay, and surfaces milestones, decisions, blockers, and security
incidents back to humans. It never writes code — it relays, surfaces, and
escalates.

## Install

```bash
agentworkforce install @agentworkforce/persona-slack-comms
# or, to refresh an existing copy:
agentworkforce install @agentworkforce/persona-slack-comms --overwrite
```

The CLI copies `personas/slack-comms.json` (and its `slack-comms.md` agentsMd
sidecar) into the consumer's `.agentworkforce/workforce/personas/` (the
directory the persona loader scans). `package.json` advertises the pack via:

```json
"agentworkforce": { "personas": "personas" }
```

Connect Slack through relayfile first so the `.integrations/slack/...` mount and
`.integrations/discovery/slack/...` discovery tree are present before launch.

## Skills

The persona pulls its operating skills from published collections (not
repo-local file paths), so a launch never hard-fails on a missing sidecar:

- `@agent-relay/setting-up-relayfile` — the relayfile mount + writeback-as-files
  recipe (mount layout, writeback status/retry, creds/cloud-mount gotchas).
- `@agent-relay/workspace-layout` — navigate a mount via `LAYOUT.md` /
  `.layout.md` and the `by-title/` `by-id/` `by-name/` alias subtrees instead of
  guessing paths, to locate Slack channels/threads/messages.
- `@agent-relay/writeback-as-files` — the drop-JSON-at-the-canonical-path
  writeback contract: `.schema.json` discovery, idempotency keys, `relayfile
  writeback list` / `status`, and `.relay/dead-letter/` recovery.
- `@agent-relay/orchestrating-agent-relay` — outside-the-team relay reference
  for CLI-first reading of team state (milestones / decisions / blockers).
- `@agent-workforce/persona-relayfile-mount` — mount-field policy (allow-list
  idiom, `readonlyPatterns` scope, per-agent dotfile overlay, `.git` sandbox).

## Key behaviors

The full operating spec lives in the `agentsMd` sidecar
[`personas/slack-comms.md`](./personas/slack-comms.md):

- **Two-way liaison** — relay inbound human messages to the agent team; surface
  outbound team milestones / decisions / blockers / security incidents to humans.
- **Escalate, don't decide** — never choose an implementation path; route
  decisions to the team and report back.
- **Writeback-as-files** — reply by writing JSON files under the mounted Slack
  writeback path, then **verify the flush** via the mount `state.json`
  (`status: ready`, `pendingWriteback: 0`) before reporting a message delivered.
- **Threaded, brief-yet-detailed style** with real `<@MEMBERID>` mentions.
- **Drop-guard** — treat `~/.agentworkforce/pear/integration-events.log` as the
  source of truth; any `received` without a matching `injecting` is a dropped
  message recovered via a temporary out-of-band relayfile read (a stopgap until
  the server-side injection fix lands, not permanent infrastructure).

## Programmatic usage

```ts
import persona from '@agentworkforce/persona-slack-comms';

console.log(persona.id); // slack-comms
```

## Publishing

Published via the `Publish Internal Persona Packs` GitHub workflow
(`.github/workflows/publish-internal-personas.yml`) using npm **provenance**
(trusted publishing). The workflow publishes all `@agentworkforce/persona-*`
packs by default, or one or more selected packs via the `package` input.
