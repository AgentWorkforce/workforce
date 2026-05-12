# Example: `weekly-digest`

Weekly competitive-intel agent. Runs every Saturday at 09:00 UTC, queries
Brave Search for the configured topics, dedupes + clusters by source host,
and upserts a single GitHub issue per ISO week into `WEEKLY_DIGEST_REPO`.

## Required env

```sh
export WEEKLY_DIGEST_TOPICS="agentworkforce,relayfile,proactive-agents"
export WEEKLY_DIGEST_REPO="YourOrg/weekly-digest"
export BRAVE_API_KEY="brave_..."

# GitHub credentials — either path works:
export WORKFORCE_INTEGRATION_GITHUB_TOKEN="ghp_..."
# or, for a quick demo without Relayfile:
export GITHUB_TOKEN="ghp_..."

# Workspace (only needed when actually launching, not for --dry-run):
export WORKFORCE_WORKSPACE_ID="ws_demo"
export WORKFORCE_WORKSPACE_TOKEN="ws_token_..."
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
the command line, drive the bundle directly:

```sh
echo '{"id":"manual-1","workspace":"ws_demo","type":"cron.tick","occurredAt":"2026-05-12T09:00:00Z","name":"weekly","cron":"0 9 * * 6"}' \
  | node /tmp/wf-weekly-digest/runner.mjs
```

The handler will:

1. Resolve topics + repo + tokens from env.
2. Query Brave Search per topic.
3. Dedupe by URL and cluster results by source host.
4. Upsert a single `Weekly digest — YYYY-WNN` issue in the target repo.
5. Save a memory note tagged `weekly-digest` + `week:<W>`.
