# Example: `weekly-digest`

Weekly competitive-intel agent. Runs every Saturday at 09:00 UTC, queries
Brave Search for the configured topics, dedupes + clusters by source host,
and upserts a single GitHub issue per ISO week into `WEEKLY_DIGEST_REPO`.

## How GitHub writes happen

Workforce integration clients **don't make direct REST calls to GitHub**.
The handler calls `ctx.github.upsertIssue(...)`, which writes a draft
JSON file at the canonical Relayfile path
`/github/repos/<owner>/<repo>/issues/...` inside the Relayfile mount.
Relayfile's writeback worker picks up the draft, makes the real GitHub
call, and writes a receipt back to the same file. The handler reads the
receipt to populate issue numbers, URLs, etc.

This matches the rest of the workforce/cloud stack and gets writeback
durability + retry semantics for free. There's no `GITHUB_TOKEN` to
manage — Relayfile holds the GitHub App / OAuth credentials.

## Required env

```sh
export WEEKLY_DIGEST_TOPICS="agentworkforce,relayfile,proactive-agents"
export WEEKLY_DIGEST_REPO="YourOrg/weekly-digest"
export BRAVE_API_KEY="brave_..."

# Workspace (only needed when actually launching, not for --dry-run):
export WORKFORCE_WORKSPACE_ID="ws_demo"
export WORKFORCE_WORKSPACE_TOKEN="ws_token_..."

# Relayfile mount root the handler writes into. The workforce runtime
# sets this automatically when it spawns the handler. Only set it
# manually when running the bundle stand-alone (smoke tests).
export RELAYFILE_MOUNT_ROOT="/path/to/your/relayfile/mount"
```

## Deploy

```sh
# Validate the persona without side effects.
workforce deploy ./examples/weekly-digest/persona.json --dry-run

# Stage the bundle to a directory and inspect it (no launch).
workforce deploy ./examples/weekly-digest/persona.json \
  --bundle-out /tmp/wf-weekly-digest

# Run locally as a long-lived process; pipe an envelope on stdin to fire
# the handler immediately. The runner exits when stdin closes.
workforce deploy ./examples/weekly-digest/persona.json --mode dev
```

## Firing the handler manually

The runner reads NDJSON envelopes from stdin. To trigger the handler from
the command line against a Relayfile mount you've already set up, drive
the bundle directly:

```sh
RELAYFILE_MOUNT_ROOT=/path/to/mount \
echo '{"id":"manual-1","workspace":"ws_demo","type":"cron.tick","occurredAt":"2026-05-12T09:00:00Z","name":"weekly","cron":"0 9 * * 6"}' \
  | node /tmp/wf-weekly-digest/runner.mjs
```

The handler will:

1. Resolve topics + repo from env.
2. Query Brave Search per topic.
3. Dedupe by URL and cluster results by source host.
4. Write a draft (or update an existing) `Weekly digest — YYYY-WNN`
   issue under `<mount>/github/repos/<owner>/<repo>/issues/...`.
   Relayfile's writeback worker turns the file write into the actual
   GitHub call.
5. Save a memory note tagged `weekly-digest` + `week:<W>`.
