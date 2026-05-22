#!/usr/bin/env bash
# trigger-issue.sh — manually drive the proactive-issue-resolver persona
# against a single, named GitHub issue.
#
# `agentworkforce deploy --mode dev` reads NDJSON envelopes from stdin. This
# script fetches a real issue via `gh`, wraps it in a `github.issues.opened`
# envelope, and pipes it to one deploy invocation. The runner processes the
# one envelope, then exits when stdin closes — so the script is short-lived,
# not a long-running subscription.
#
# Usage:
#   ./trigger-issue.sh <owner> <repo> <issue-number>
#
# Env:
#   PROACTIVE_SLACK_USER (or PROACTIVE_SLACK_CHANNEL) — required, forwarded
#       to the deploy as the Slack notify target.
#
# Prereqs: gh authed, agentworkforce logged in, ricky installed in the
# example dir (npm install).

set -euo pipefail

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <owner> <repo> <issue-number>" >&2
  exit 2
fi

OWNER=$(trim "$1")
REPO=$(trim "$2")
NUM=$(trim "$3")

if ! [[ "$OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; then
  echo "error: invalid owner (allowed: GitHub owner name characters, no slashes)" >&2
  exit 2
fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: invalid repo (allowed: [A-Za-z0-9._-], no slashes)" >&2
  exit 2
fi
if ! [[ "$NUM" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: issue number must be a positive integer" >&2
  exit 2
fi

if [[ -z "${PROACTIVE_SLACK_USER:-}" && -z "${PROACTIVE_SLACK_CHANNEL:-}" ]]; then
  echo "error: set PROACTIVE_SLACK_USER or PROACTIVE_SLACK_CHANNEL" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq)" >&2
  exit 2
fi

ACTIVE=$HOME/.agentworkforce/active.json
if [[ ! -f "$ACTIVE" ]]; then
  echo "error: $ACTIVE not found — run \`agentworkforce login\` first" >&2
  exit 2
fi
WORKSPACE_ID=$(jq -r '.workspace // empty' "$ACTIVE")
if [[ -z "$WORKSPACE_ID" || "$WORKSPACE_ID" == "null" ]]; then
  echo "error: no .workspace in $ACTIVE — run \`agentworkforce login\` first" >&2
  exit 2
fi

SCRIPT_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
PERSONA="$SCRIPT_DIR/persona.json"
if [[ ! -f "$PERSONA" ]]; then
  echo "error: persona not found at $PERSONA" >&2
  exit 2
fi

echo "→ fetching issue $OWNER/$REPO#$NUM via gh"
ISSUE=$(gh api "repos/$OWNER/$REPO/issues/$NUM")
REPOSITORY=$(gh api "repos/$OWNER/$REPO")

# The runtime shim splits `github.issues.opened` into source=github,
# type=issues.opened and treats `resource` as the GitHub webhook payload.
ENVELOPE=$(jq -n \
  --arg id "manual-${OWNER}-${REPO}-${NUM}-$(date +%s)" \
  --arg ws "$WORKSPACE_ID" \
  --arg occurredAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson issue "$ISSUE" \
  --argjson repository "$REPOSITORY" \
  '{
     id: $id,
     workspace: $ws,
     type: "github.issues.opened",
     occurredAt: $occurredAt,
     resource: { action: "opened", issue: $issue, repository: $repository }
   }')

echo "→ piping envelope into agentworkforce deploy (cwd=$(pwd))"
printf '%s\n' "$ENVELOPE" | agentworkforce deploy "$PERSONA" --mode dev
