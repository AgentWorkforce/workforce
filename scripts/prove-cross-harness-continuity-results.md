# Cross-harness session continuity proof — 2026-08-13

## Result

**Protocol-level proof passed.** A fresh `claude --print` invocation reproduced the
linked-list reversal function after receiving only the context reconstructed from
the relay session's HTTP retrieval responses.

- Relay session ID: `dd4f9c6d-57ee-4474-9637-eaed3f53e170`
- Service used for the completed run: isolated local relayhistory protocol mock
- Observable artifacts: `/var/folders/_z/f_fpl8j533g_r63706k2xvp00000gn/T/relayhistory-continuity.9ZdIe6`

## JSONL round trip

Passed. Phase 1 wrote five JSONL records to the mock service's private store: four
ordered turns and one metadata record. Phase 2 used only HTTP `GET` calls and
returned the turns in sequence `1, 2, 3, 4`, plus this metadata:

```json
{"nativeCli":"codex","sessionOwner":"danny@test.com","originNode":"finn-mini"}
```

The reconstructed prompt came from those two retrieved payloads; it did not read
the JSONL file or use a Codex/Claude session-resume mechanism.

## Cross-harness continuation

Passed. The fresh Claude process received the reconstructed prior conversation on
stdin and returned the expected function, including all four proof markers:

```js
function reverseLinkedList(head) {
  let previous = null;
  let current = head;

  while (current !== null) {
    const next = current.next;
    current.next = previous;
    previous = current;
    current = next;
  }

  return previous;
}
```

The script starts Claude with `--print`, no `--resume` flag, no Codex session ID,
and no filesystem path to the relay JSONL. The only continuity input is the
reconstructed context. Claude naturally uses its own existing CLI authentication to
answer; no Codex credential or session credential is passed to it.

## Deployed-service gap

`https://dev.history.agentrelay.com/health` returned HTTP 200 with
`{"ok":true,"service":"relayhistory"}`. However, the deployed service cannot
currently complete this proof through the requested session contract:

- The checked-in `relayhistory-cloud` application registers `/v1/ingest`, coverage,
  Pair/Reflex, and Enterprise sync/entries/export routes, but not
  `/v1/sessions/:id/turns` or `/v1/sessions/:id/metadata`.
- An unauthenticated probe of both requested dev paths returned HTTP 401 from the
  service-wide authentication middleware. No non-production relay credential was
  supplied or logged, and there is therefore no evidence that the deployed service
  can seed/retrieve this session model.

The script makes this distinction explicit: it attempts the remote session API only
when a mode-600 `RELAYHISTORY_CURL_CONFIG` is provided, otherwise falls back to the
isolated mock and prints a qualification. A deployed-cloud pass requires the two
session endpoints, a durable JSONL-backed implementation, and scoped authenticated
access.

## Re-run

```sh
./scripts/prove-cross-harness-continuity.sh
```

The default run health-checks dev and falls back to the local mock. Use `--remote`
with `RELAYHISTORY_CURL_CONFIG` only after the deployed session API exists.
