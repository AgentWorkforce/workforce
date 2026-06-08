# @agentworkforce/persona-slack-relayfile-doctor

A **debugging-specialist** AgentWorkforce persona for the Slack ↔ relayfile ↔
cloud sync/writeback stack. Where `persona-slack-comms` is comms-only, this
persona is the *engineer* for the integration pipeline: it localizes a symptom
to the right layer, confirms the root cause with concrete evidence, and
prescribes the fix to the owning repo.

## When to use it

Spin up `slack-relayfile-doctor` when an integration regression appears:

- Inbound Slack messages stop reading down to disk (channel, thread, or DM).
- An `<integration-event>` preview says `Message: unavailable` though the bytes
  may be on disk.
- An outbound writeback (channel post, thread reply, or DM) silently doesn't
  deliver — no error, no dead-letter.
- A mount wedges (`context deadline exceeded`, zero completed cycles).
- Duplicate posts, or any "it worked yesterday" sync/writeback regression.

## What it knows

The persona's playbook (`personas/slack-relayfile-doctor.md`) encodes:

- **Topology** — the five layers (Slack → Nango → cloud TS worker → relayfile-mount
  daemon → local mount → pear) and which repo owns each.
- **Diagnostic toolkit** — reading `mount.log`/`state.json`, the relayfile **ops
  API** recipe (`GET …/ops/<opId>`, with the required `X-Correlation-Id`) to read
  a writeback's `lastError`, the event-injection log, and which `wrangler tail`
  worker actually carries the error.
- **Symptom → root cause → fix decision trees** — write-only-vs-mirror mounts,
  bare-vs-suffixed channel ids, the preview two-shape gap, mount wedges, the
  `missing_scope`/`im:write` 3-place fix, duplicate dispatch, and silent-send.
- **Fix-to-layer matching** — never prescribe a Pear restart for a cloud-side bug,
  or a cloud deploy for a mount-topology bug.

## Layout

```
personas/
  slack-relayfile-doctor.json   # persona spec (id, skills, harness, model, memory)
  slack-relayfile-doctor.md     # claudeMd playbook (source of truth for the knowledge)
index.js / index.d.ts           # compatibility export of the persona JSON
```

Trajectory memory is enabled via the persona's opt-in `memory.trajectories`
facet; curated diagnostic trajectories live under the workspace `.trajectories/`
corpus so the persona can retrieve past decision arcs (the "why").

## Install

```
agentworkforce install @agentworkforce/persona-slack-relayfile-doctor
```
