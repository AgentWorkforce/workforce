#!/usr/bin/env bash
# Proves that a fresh Claude invocation can continue a Codex-originated relay
# session using the reconstructed conversation returned by the relay service.
#
# Default behaviour is deliberately safe: it probes the deployed production health
# endpoint without credentials, then uses an isolated local protocol mock when
# the required /v1/sessions/:id/{turns,metadata} API cannot be used.  Set
# RELAYHISTORY_CURL_CONFIG to a mode-600 curl config file (for example,
# containing `header = "Authorization: Bearer ..."`) to attempt a real service
# first. The config is never printed or copied into the proof artifacts.

set -euo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly DEFAULT_BASE_URL="https://history.agentrelay.com"
readonly TURN_COUNT=4

BASE_URL="${RELAYHISTORY_BASE_URL:-$DEFAULT_BASE_URL}"
MODE="auto"
OUTPUT_DIR=""

usage() {
  cat <<'USAGE'
Usage: prove-cross-harness-continuity.sh [options]

Options:
  --base-url URL    Relayhistory base URL (default: history.agentrelay.com)
  --local           Skip the remote probe and run against the isolated local mock
  --remote          Require the remote session API; do not fall back to the mock
  --output-dir DIR  Directory for observable, non-secret proof artifacts
  -h, --help        Show this help

Environment:
  RELAYHISTORY_CURL_CONFIG  Path to a mode-600 curl config with remote auth headers.
                            It is used only for the remote service and is never logged.
  RELAYHISTORY_BASE_URL     Alternative to --base-url.
USAGE
}

while (($# > 0)); do
  case "$1" in
    --base-url)
      BASE_URL="${2:?--base-url requires a value}"
      shift 2
      ;;
    --local)
      MODE="local"
      shift
      ;;
    --remote)
      MODE="remote"
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="${2:?--output-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'ERROR: %s requires %s on PATH\n' "$SCRIPT_NAME" "$1" >&2
    exit 2
  }
}

for command in curl jq node uuidgen claude; do
  require_command "$command"
done

if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
else
  OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relayhistory-continuity.XXXXXX")"
fi
chmod 700 "$OUTPUT_DIR"

RUN_DIR="$OUTPUT_DIR"
STORE_FILE="$RUN_DIR/relayhistory.jsonl"
PORT_FILE="$RUN_DIR/mock-port"
TURNS_PAYLOAD="$RUN_DIR/turns-request.json"
METADATA_PAYLOAD="$RUN_DIR/metadata-request.json"
TURNS_RESPONSE="$RUN_DIR/turns-response.json"
METADATA_RESPONSE="$RUN_DIR/metadata-response.json"
CONTEXT_FILE="$RUN_DIR/reconstructed-context.txt"
CLAUDE_RESPONSE="$RUN_DIR/claude-response.txt"
CLAUDE_STDERR="$RUN_DIR/claude-stderr.txt"
REMOTE_PROBE_BODY="$RUN_DIR/remote-health.json"
MOCK_PID=""

cleanup() {
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -n "${RELAYHISTORY_CURL_CONFIG:-}" ]]; then
  if [[ ! -f "$RELAYHISTORY_CURL_CONFIG" ]]; then
    printf 'ERROR: RELAYHISTORY_CURL_CONFIG does not exist\n' >&2
    exit 2
  fi
  if [[ "$(stat -f '%Lp' "$RELAYHISTORY_CURL_CONFIG" 2>/dev/null || stat -c '%a' "$RELAYHISTORY_CURL_CONFIG")" != "600" ]]; then
    printf 'ERROR: RELAYHISTORY_CURL_CONFIG must have mode 600\n' >&2
    exit 2
  fi
fi

json_status() {
  local output_file="$1"
  shift
  if [[ -n "${RELAYHISTORY_CURL_CONFIG:-}" ]]; then
    curl --config "$RELAYHISTORY_CURL_CONFIG" --silent --show-error --output "$output_file" --write-out '%{http_code}' --max-time 20 "$@"
  else
    curl --silent --show-error --output "$output_file" --write-out '%{http_code}' --max-time 20 "$@"
  fi
}

is_success_status() {
  [[ "$1" =~ ^2[0-9][0-9]$ ]]
}

start_mock() {
  : > "$STORE_FILE"
  node - "$STORE_FILE" "$PORT_FILE" <<'NODE' &
const fs = require("fs");
const http = require("http");

const [storeFile, portFile] = process.argv.slice(2);

function events() {
  const input = fs.readFileSync(storeFile, "utf8").trim();
  return input ? input.split("\n").map((line) => JSON.parse(line)) : [];
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    return writeJson(response, 200, { ok: true, service: "relayhistory-local-proof-mock" });
  }

  const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/(turns|metadata)$/);
  if (!match) return writeJson(response, 404, { error: "not_found" });

  const sessionId = decodeURIComponent(match[1]);
  const resource = match[2];
  if (request.method === "POST") {
    try {
      const body = await requestBody(request);
      if (resource === "turns") {
        if (!Array.isArray(body.turns)) return writeJson(response, 400, { error: "turns must be an array" });
        for (const turn of body.turns) {
          fs.appendFileSync(storeFile, `${JSON.stringify({
            type: "turn",
            sessionId,
            turn: { ...turn, sessionOwner: turn.sessionOwner ?? body.sessionOwner },
          })}\n`);
        }
        return writeJson(response, 201, { sessionId, stored: body.turns.length });
      }
      fs.appendFileSync(storeFile, `${JSON.stringify({ type: "metadata", sessionId, metadata: body })}\n`);
      return writeJson(response, 201, { sessionId, stored: "metadata" });
    } catch (error) {
      return writeJson(response, 400, { error: error instanceof Error ? error.message : "bad_json" });
    }
  }

  if (request.method === "GET") {
    const sessionEvents = events().filter((event) => event.sessionId === sessionId);
    if (resource === "turns") {
      const turns = sessionEvents
        .filter((event) => event.type === "turn")
        .map((event) => event.turn)
        .sort((left, right) => left.turnIndex - right.turnIndex);
      return writeJson(response, 200, { sessionId, turns });
    }
    const metadataEvent = sessionEvents.filter((event) => event.type === "metadata").at(-1);
    return writeJson(response, 200, { sessionId, metadata: metadataEvent ? metadataEvent.metadata : null });
  }

  return writeJson(response, 405, { error: "method_not_allowed" });
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
NODE
  MOCK_PID=$!

  for _ in $(seq 1 100); do
    [[ -s "$PORT_FILE" ]] && break
    sleep 0.05
  done
  [[ -s "$PORT_FILE" ]] || {
    printf 'ERROR: local relayhistory protocol mock did not start\n' >&2
    exit 1
  }
  BASE_URL="http://127.0.0.1:$(<"$PORT_FILE")"
}

RELAY_SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
export RELAY_SESSION_ID

node - "$TURNS_PAYLOAD" <<'NODE'
const fs = require("fs");
const output = process.argv[2];
const sessionId = process.env.RELAY_SESSION_ID;
const at = (second) => new Date(Date.UTC(2026, 7, 13, 8, 0, second)).toISOString();
const functionSource = [
  "function reverseLinkedList(head) {",
  "  let previous = null;",
  "  let current = head;",
  "",
  "  while (current !== null) {",
  "    const next = current.next;",
  "    current.next = previous;",
  "    previous = current;",
  "    current = next;",
  "  }",
  "",
  "  return previous;",
  "}",
].join("\n");
fs.writeFileSync(output, JSON.stringify({
  sessionOwner: "danny@test.com",
  turns: [
    {
      turnIndex: 0,
      role: "user",
      actorName: "Danny",
      actorRole: "owner",
      metadata: { nativeCli: "codex", originNode: "finn-mini" },
      ts: at(1),
      content: "Write a JavaScript function that reverses a singly linked list. Use an iterative solution and return the new head.",
    },
    {
      turnIndex: 1,
      role: "assistant",
      actorName: "Codex",
      actorRole: "steerer",
      metadata: { nativeCli: "codex", originNode: "finn-mini" },
      ts: at(2),
      content: `Here is the working iterative solution:\n\n${functionSource}`,
    },
    {
      turnIndex: 2,
      role: "user",
      actorName: "Danny",
      actorRole: "owner",
      metadata: { nativeCli: "codex", originNode: "finn-mini" },
      ts: at(3),
      content: "Why does this work?",
    },
    {
      turnIndex: 3,
      role: "assistant",
      actorName: "Codex",
      actorRole: "steerer",
      metadata: { nativeCli: "codex", originNode: "finn-mini" },
      ts: at(4),
      content: "Each iteration saves the next node before redirecting current.next to the already-reversed prefix. When current reaches null, previous is the new head.",
    },
  ],
}, null, 2));
NODE

node - "$METADATA_PAYLOAD" <<'NODE'
const fs = require("fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  nativeCli: "codex",
  sessionOwner: "danny@test.com",
  originNode: "finn-mini",
}, null, 2));
NODE

REMOTE_HEALTH_STATUS="not-probed"
SERVICE_KIND="remote relayhistory"
if [[ "$MODE" != "local" ]]; then
  REMOTE_HEALTH_STATUS="$(json_status "$REMOTE_PROBE_BODY" "$BASE_URL/health" || true)"
  if is_success_status "$REMOTE_HEALTH_STATUS" && [[ -n "${RELAYHISTORY_CURL_CONFIG:-}" ]]; then
    printf 'REMOTE PREFLIGHT: %s/health returned HTTP %s; attempting the session API.\n' "$BASE_URL" "$REMOTE_HEALTH_STATUS"
  elif [[ "$MODE" == "remote" ]]; then
    printf 'ERROR: remote proof requires a healthy endpoint and RELAYHISTORY_CURL_CONFIG. Health HTTP: %s\n' "$REMOTE_HEALTH_STATUS" >&2
    exit 1
  else
    printf 'REMOTE PREFLIGHT: %s/health returned HTTP %s. Required authenticated session API credentials were not supplied.\n' "$BASE_URL" "$REMOTE_HEALTH_STATUS"
    start_mock
    SERVICE_KIND="isolated local relayhistory protocol mock"
  fi
else
  printf 'REMOTE PREFLIGHT: skipped by --local.\n'
  start_mock
  SERVICE_KIND="isolated local relayhistory protocol mock"
fi

post_seed() {
  local turns_status metadata_status
  turns_status="$(json_status "$RUN_DIR/turns-post-response.json" -X POST -H 'content-type: application/json' --data-binary "@$TURNS_PAYLOAD" "$BASE_URL/v1/sessions/$RELAY_SESSION_ID/turns" || true)"
  if ! is_success_status "$turns_status"; then
    printf 'POST turns failed with HTTP %s:\n' "$turns_status" >&2
    sed -n '1,80p' "$RUN_DIR/turns-post-response.json" >&2
    return 1
  fi
  # PR #23 derives session metadata from the ordered turn journal. The isolated
  # mock retains the former separate metadata endpoint to prove the original
  # two-resource JSONL protocol as a local fallback.
  if [[ "$SERVICE_KIND" == "remote relayhistory" ]]; then
    return 0
  fi
  metadata_status="$(json_status "$RUN_DIR/metadata-post-response.json" -X POST -H 'content-type: application/json' --data-binary "@$METADATA_PAYLOAD" "$BASE_URL/v1/sessions/$RELAY_SESSION_ID/metadata" || true)"
  if ! is_success_status "$metadata_status"; then
    printf 'POST metadata failed with HTTP %s:\n' "$metadata_status" >&2
    sed -n '1,80p' "$RUN_DIR/metadata-post-response.json" >&2
  fi
  is_success_status "$metadata_status"
}

if ! post_seed; then
  if [[ "$MODE" == "auto" && -z "$MOCK_PID" ]]; then
    printf 'REMOTE SESSION API: unavailable for this proof; falling back to the local protocol mock.\n'
    start_mock
    SERVICE_KIND="isolated local relayhistory protocol mock"
    post_seed || {
      printf 'ERROR: the local protocol mock rejected seed data\n' >&2
      exit 1
    }
  else
    printf 'ERROR: unable to seed the selected relayhistory session API\n' >&2
    exit 1
  fi
fi

if [[ "$SERVICE_KIND" == "isolated local relayhistory protocol mock" ]]; then
  jsonl_record_count="$(wc -l < "$STORE_FILE" | tr -d '[:space:]')"
  if [[ "$jsonl_record_count" != "$((TURN_COUNT + 1))" ]]; then
    printf 'ERROR: expected %s JSONL records in the local relayhistory store, found %s\n' "$((TURN_COUNT + 1))" "$jsonl_record_count" >&2
    exit 1
  fi
  printf 'PHASE 1 — JSONL STORE: persisted %s records (%s turns + metadata).\n' "$jsonl_record_count" "$TURN_COUNT"
fi

turns_status="$(json_status "$TURNS_RESPONSE" "$BASE_URL/v1/sessions/$RELAY_SESSION_ID/turns")"
metadata_status="$(json_status "$METADATA_RESPONSE" "$BASE_URL/v1/sessions/$RELAY_SESSION_ID/metadata")"
if ! is_success_status "$turns_status" || ! is_success_status "$metadata_status"; then
  printf 'ERROR: retrieval failed (turns HTTP %s; metadata HTTP %s)\n' "$turns_status" "$metadata_status" >&2
  exit 1
fi

printf '\nCONTINUITY-PROOF SESSION ID: %s\n' "$RELAY_SESSION_ID"
printf 'SERVICE: %s\n' "$SERVICE_KIND"
printf 'ARTIFACT DIRECTORY: %s\n' "$RUN_DIR"

node - "$TURNS_RESPONSE" "$METADATA_RESPONSE" "$CONTEXT_FILE" "$RELAY_SESSION_ID" <<'NODE'
const fs = require("fs");
const [turnsPath, metadataPath, contextPath, sessionId] = process.argv.slice(2);
const turnsPayload = JSON.parse(fs.readFileSync(turnsPath, "utf8"));
const metadataPayload = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const turns = turnsPayload.turns;
const metadata = metadataPayload.metadata ?? metadataPayload;

if (!Array.isArray(turns) || turns.length !== 4) {
  throw new Error(`expected 4 turns from retrieval, got ${Array.isArray(turns) ? turns.length : "non-array"}`);
}
for (let index = 0; index < turns.length; index += 1) {
  const turnIndex = turns[index].turnIndex ?? (turns[index].sequence - 1);
  if (turnIndex !== index) {
    throw new Error(`turn order is wrong at position ${index}: ${turnIndex}`);
  }
}
if (!turns[1].content.includes("function reverseLinkedList(head)")) {
  throw new Error("retrieved assistant turn is missing the linked-list function");
}
const allowedOwners = new Set(["danny@test.com", "[REDACTED]"]);
if (!metadata || !allowedOwners.has(metadata.sessionOwner) || metadata.nativeCli !== "codex") {
  throw new Error("retrieved metadata is missing a valid sessionOwner or nativeCli");
}
if (!turns.every((turn) => allowedOwners.has(turn.sessionOwner))) {
  throw new Error("retrieved turns have an unexpected sessionOwner value");
}
if (metadata.sessionOwner === "[REDACTED]") {
  process.stdout.write("SESSION OWNER: PII scrubber redacted danny@test.com as [REDACTED] on the service round trip.\n");
}

const formattedTurns = turns.map((turn) => [
  `TURN ${(turn.turnIndex ?? (turn.sequence - 1)) + 1} | ${turn.role.toUpperCase()} | ${turn.actorName ?? turn.actor} | ${turn.ts ?? turn.createdAt}`,
  turn.content,
].join("\n")).join("\n\n");
const prompt = [
  "You are Dev, starting a fresh Claude session on a different harness.",
  "The text below is the complete prior conversation retrieved from relayhistory.",
  "Treat it as authoritative prior context; do not claim that you lack context.",
  `Relay session ID: ${sessionId}`,
  `Session metadata: ${JSON.stringify(metadata)}`,
  "",
  "--- BEGIN RETRIEVED PRIOR CONVERSATION ---",
  formattedTurns,
  "--- END RETRIEVED PRIOR CONVERSATION ---",
  "",
  "Based on the prior conversation, what was the linked list reversal function that was written? Show it.",
].join("\n");
fs.writeFileSync(contextPath, `${prompt}\n`);
NODE

printf '\nPHASE 2 — RECONSTRUCTED CONTEXT (from GET responses)\n'
sed -n '1,260p' "$CONTEXT_FILE"

printf '\nPHASE 3 — FRESH CLAUDE CONTINUATION\n'
# `--print` starts a new non-interactive Claude session. We pass no Codex session
# id, no Claude --resume flag, and no filesystem path to the JSONL—only stdin
# containing the context reconstructed from the two GET responses.
(
  unset CLAUDECODE
  cd "$RUN_DIR"
  claude --print < "$CONTEXT_FILE"
) > "$CLAUDE_RESPONSE" 2> "$CLAUDE_STDERR" &
CLAUDE_PID=$!
CLAUDE_EXIT=""
for _ in $(seq 1 120); do
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
    set +e
    wait "$CLAUDE_PID"
    CLAUDE_EXIT=$?
    set -e
    break
  fi
  sleep 0.5
done
if [[ -z "$CLAUDE_EXIT" ]]; then
  kill "$CLAUDE_PID" 2>/dev/null || true
  wait "$CLAUDE_PID" 2>/dev/null || true
  printf 'PROOF FAILS: claude --print did not finish within 60 seconds.\n' >&2
  exit 1
fi
if [[ "$CLAUDE_EXIT" -ne 0 ]]; then
  printf 'PROOF FAILS: claude --print exited %s.\n' "$CLAUDE_EXIT" >&2
  sed -n '1,120p' "$CLAUDE_STDERR" >&2
  exit 1
fi

sed -n '1,260p' "$CLAUDE_RESPONSE"

node - "$CLAUDE_RESPONSE" <<'NODE'
const fs = require("fs");
const response = fs.readFileSync(process.argv[2], "utf8");
const expected = [
  /function\s+reverseLinkedList\s*\(\s*head\s*\)/,
  /while\s*\(\s*current\s*!==?\s*null\s*\)/,
  /current\.next\s*=\s*previous/,
  /return\s+previous\s*;/,
];
const missing = expected.filter((pattern) => !pattern.test(response));
if (missing.length > 0) {
  throw new Error("Claude did not reproduce the retrieved function's required elements");
}
NODE

printf '\nPROOF PASSES: retrieval preserved all %s ordered turns and metadata; fresh Claude reproduced reverseLinkedList from reconstructed relay context.\n' "$TURN_COUNT"
if [[ "$SERVICE_KIND" != "remote relayhistory" ]]; then
  printf 'QUALIFICATION: this particular run used the isolated local mock. Run with --remote and a scoped relayhistory curl config for deployed-cloud evidence.\n'
fi
