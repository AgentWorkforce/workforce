# `slack-reaction-archiver`

A deployable persona that's **triggered by a Slack event**. React with ✅
(`:white_check_mark:`) to a GitHub-email digest in Slack and this agent archives
those Gmail messages — the Slack-native approval gate for
[`../github-email-digest`](../github-email-digest/).

It's also the concrete answer to "show the trigger autocomplete *used* in a
persona": [`persona.ts`](./persona.ts) declares

```ts
integrations: {
  slack: {
    triggers: [
      { on: 'reaction.added' },   // ✅ → archive
      { on: 'reaction.removed' }  // un-✅ → restore to inbox
    ]
  },
  gmail: {}
}
```

Each `on` is suggested by your editor (and lint-checked at deploy) because
`slack` is in `KNOWN_TRIGGER_CATALOG` — the catalog PR #113 exposed.

## Adding multiple triggers

`triggers` is just an array — add as many `{ on: … }` entries as you want, and
**each `on` autocompletes independently**. The event's `type` is matched against
each entry, and the handler branches on `event.type`:

```ts
slack: {
  triggers: [
    { on: 'reaction.added' },
    { on: 'reaction.removed' },
    // Each entry can also narrow with optional `match` / `where` filters:
    { on: 'message.created', where: "channel == 'C_GITHUB_ALERTS'" }
  ]
}
```

You can spread triggers across providers too — e.g. add a `github: { triggers:
[{ on: 'pull_request.opened' }] }` block alongside `slack`; each provider's list
autocompletes its own events. The handler sees every matched event and switches
on `event.source` + `event.type`.

## Flow

```
you react :white_check_mark: to the digest DM
  → slack reaction.added event fires this handler   (slack trigger)
  → it reads the reacted message from the Slack VFS  (channel + ts from the event)
  → extracts [[gh:<threadId>]] tokens the digest embedded
  → archives each Gmail thread (removeLabelIds INBOX) via the modify writeback
  → replies in-thread: ":file_cabinet: Archived N GitHub emails"

remove the :white_check_mark: again
  → slack reaction.removed event fires the same handler
  → restores those threads to the inbox (addLabelIds INBOX) — an undo
```

The digest agent emits a muted `_refs:_ [[gh:…]] [[gh:…]]` line; this agent
scans for those tokens. If it can't read the reacted message, it does
**nothing** — it never guesses what to archive.

## Configure

| Input | Default | Effect |
| --- | --- | --- |
| `EMOJI` | `white_check_mark` | Reaction that approves archiving (no colons). |
| `GMAIL_ACCOUNT` | `me` | Account segment in `/gmail/<account>/threads`. |
| `DRY_RUN` | `false` | `true` = detect + reply, but never write the archive. |

## Deploy

```sh
agentworkforce persona compile ./persona.ts            # CLI/persona-kit ≥ 3.0.23
agentworkforce deploy ./persona.json --mode dev --dry-run
```

> **Note on the deploy lint:** with an older CLI (≤ 3.0.21) the dry-run prints
> `trigger "reaction.added" is not in the known-trigger registry for slack` —
> that CLI bundles a **stale** catalog (`app_mention, message.channels`). The
> current catalog (persona-kit ≥ 3.0.23 / `@relayfile/adapter-core`) has
> `reaction.added`, so a matching CLI lints clean. The warning is advisory
> regardless: the runtime still applies the trigger and matches the adapter's
> real `event.type`.
