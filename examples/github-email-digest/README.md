# `github-email-digest`

A proactive agent you can deploy. **Three times a day** it scans your Gmail
inbox for emails from GitHub, **Slack-DMs you a summary**, and **archives only
the messages you've approved** — it never archives anything you didn't
explicitly OK.

```
cron (08:00 / 13:00 / 18:00)
  → read /gmail/<account>/threads/*.json from the Relayfile VFS   (gmail integration)
  → keep messages still in INBOX, from GitHub senders
  → ARCHIVE the ones you labelled "Archive-Approved" last cycle   (gmail modify writeback)
  → summarize the NEW ones with ctx.llm                            (deduped via durable memory)
  → ctx.slack.dm(you, digest)                                      (slack integration)
  → "apply the Archive-Approved label to file any of these away"
```

## The "check with me before archiving" gate

The agent **proposes**, you **approve**, and only then does it archive — on the
*next* run:

1. The digest DM lists the new GitHub emails and tells you to apply the
   **`Archive-Approved`** Gmail label (configurable) to any you want filed.
2. Next run, the agent sees that label on those messages and archives them
   (removes the `INBOX` label via the Gmail `modify` writeback), then confirms
   in the DM.

Approval lives in the Gmail label, not in agent state — so even if memory is
wiped the agent can never archive something you didn't label. The Slack runtime
client is send-only, so this agent can't *read* a 👍 on its own DM — but the
companion [`../slack-reaction-archiver`](../slack-reaction-archiver/) subscribes
to the `slack` `reaction.added` trigger and archives the emails you ✅, giving
you the Slack-native approval path too.

## Configure

| Input | Default | Effect |
| --- | --- | --- |
| `SLACK_USER` | *(required)* | Your Slack user id, e.g. `U0123ABCD`. The agent DMs you here. |
| `GMAIL_ACCOUNT` | `me` | Account segment in the VFS path `/gmail/<account>/threads`. |
| `APPROVAL_LABEL` | `Archive-Approved` | Gmail label you apply to approve archiving. |
| `GITHUB_SENDERS` | `notifications@github.com,noreply@github.com,@github.com` | Sender substrings that count as "from GitHub". |
| `DRY_RUN` | `false` | `true` = compose + DM, but never write the archive. Great for the first run. |
| `FORCE_DM` | `false` | `true` = DM a heartbeat even when there are no new emails. Handy for verifying the Slack DM path on first deploy. |

`RELAYFILE_MOUNT_ROOT` (env) prefixes the VFS path when you run the bundle
stand-alone; the runtime sets it for you in `--mode cloud`.

## How Gmail reads/writes work

Like every Workforce integration, the handler does **not** call the Gmail API
directly. The `gmail` integration mounts the Relayfile VFS; the handler reads
message JSON from `/gmail/<account>/threads/*.json` and archives by *writing*
`{"removeLabelIds":["INBOX","Archive-Approved"]}` to a message's path. Relayfile's
writeback worker turns that file write into a `users/<account>/messages/<id>/modify`
call. There's no `GMAIL_TOKEN` to manage — Relayfile holds the OAuth creds.

> Archiving only takes effect when the Relayfile writeback worker is active for
> your Gmail mount. With `DRY_RUN=true` the agent reports what it *would* archive
> without writing anything.

## Deploy

```sh
# Author/edit the typed persona, then compile to the runtime artifact.
# (`persona compile` + definePersona need the CLI / persona-kit ≥ 3.0.23.
#  persona.json is already committed, so this step is optional.)
agentworkforce persona compile ./persona.ts        # persona.ts → persona.json

# Validate without side effects:
agentworkforce deploy ./persona.json --dry-run

# Run locally (reads NDJSON envelopes on stdin; fire a cron tick by hand):
SLACK_USER=U0123ABCD DRY_RUN=true \
  agentworkforce deploy ./persona.json --mode dev
```

Fire one digest run manually against a mounted Gmail VFS:

```sh
echo '{"id":"manual-1","source":"cron","name":"digest","cron":"0 8,13,18 * * *","occurredAt":"2026-05-26T13:00:00Z","attempt":1}' \
  | SLACK_USER=U0123ABCD RELAYFILE_MOUNT_ROOT=/path/to/mount DRY_RUN=true \
    agentworkforce deploy ./persona.json --mode dev
```

## Why a schedule, not a Gmail trigger?

"Three times a day" is a batch. The Gmail trigger events (`file.created`,
`file.updated`, `file.deleted` — added to `KNOWN_TRIGGER_CATALOG` via
relayfile-adapters PR #119) fire **per message in real time**, which is the
opposite of a thrice-daily digest. For an event-triggered companion that reacts
the moment you act in Slack, see [`../slack-reaction-archiver`](../slack-reaction-archiver/).

## v2 ideas

- Move approval into the chat (Telegram bot, or a Slack 👍 reaction) once an
  inbound/read path exists for it.
- Per-repo / per-notification-type filtering and routing.
- A "snooze" label that re-surfaces an email in N days instead of archiving.
