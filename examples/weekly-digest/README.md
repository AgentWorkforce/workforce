# Weekly Digest

This deployable persona runs on a weekly cron schedule, searches Brave for the configured topics, clusters findings by source host, and upserts a single GitHub issue for the ISO week.

## Setup

Connect the GitHub integration before deploying:

```bash
workforce deploy ./examples/weekly-digest/persona.json --mode dev
```

Set `BRAVE_API_KEY` in the runner environment. The persona also accepts `TOPICS`, `GITHUB_OWNER`, and `GITHUB_REPO` through its input defaults.

## Run

```bash
BRAVE_API_KEY=... workforce deploy ./examples/weekly-digest/persona.json --mode sandbox
```
