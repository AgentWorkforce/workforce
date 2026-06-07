# Slack Comms

A comms-only Slack liaison for a multi-agent engineering team. It owns all
human-facing Slack messages for the project's `#proj-cloud` channel via
relayfile writeback, relays human messages to the engineering agent team over
agent-relay `#general`, and surfaces milestones, decisions, blockers, and
security incidents back to humans. It never writes code — it relays, surfaces,
and escalates.

The full operating spec lives in the `agentsMd` sidecar
[`slack-comms.md`](./slack-comms.md): writeback-as-files discipline, flush
verification via the mount `state.json`, the threaded brief-yet-detailed style
with real `<@MEMBERID>` mentions, and the debug-log drop-guard plus the
out-of-band relayfile read used to recover dropped or degraded inbound events
(a temporary stopgap until the server-side injection fix lands).

## Run

```bash
agentworkforce agent ./examples/slack-comms/persona.json
```

Connect Slack through relayfile first so the `.integrations/slack/...` mount and
`.integrations/discovery/slack/...` discovery tree are present.
