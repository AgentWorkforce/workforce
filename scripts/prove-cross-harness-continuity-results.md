# Cross-harness session continuity proof — 2026-08-13

## Result

**Deployed production protocol proof passed (same-machine synthetic run).** The
proof seeded an authenticated synthetic Codex transcript in production and
retrieved it by relay session ID. A new `claude --print` invocation then
reproduced the linked-list reversal function using only the reconstructed prior
conversation supplied on stdin.

- Relay session ID: `ac7c0ab8-1c00-4ddd-9484-a59abf2f5bd5`
- Service: `https://history.agentrelay.com` (strict remote mode; no mock fallback)
- Observable artifacts: `/var/folders/_z/f_fpl8j533g_r63706k2xvp00000gn/T/relayhistory-continuity.YTM9qw`
- Health check: HTTP 200, `{"ok":true,"service":"relayhistory"}`

This is not yet the stricter `sf-mini` → `finn-mini` acceptance run. That requires
a real session ID from the streaming agent on `sf-mini`; the receiver is ready and
will append that evidence when it arrives.

## Turn-journal round trip

Passed. Production accepted all four synthetic Codex turns:

```json
{"sessionId":"ac7c0ab8-1c00-4ddd-9484-a59abf2f5bd5","received":4,"accepted":4}
```

`GET /v1/sessions/<id>/turns` returned exactly four records ordered by
`turnIndex` (`0, 1, 2, 3`), including the original `reverseLinkedList`
implementation. `GET /v1/sessions/<id>/metadata` returned:

```json
{
  "nativeCli": "codex",
  "nativeResumeId": null,
  "sessionOwner": "[REDACTED]",
  "originNode": "finn-mini"
}
```

The input owner was `danny@test.com`; the deployed ingest scrubber correctly
redacted it before the value was returned. The proof therefore verifies that an
owner field round-trips with deliberate PII protection, rather than expecting raw
email preservation.

## Cross-harness continuation

Passed. The new Claude process received no Codex session ID, `--resume` flag,
relay JSONL path, or Codex credential. Its only continuity input was the context
formatted from the two production `GET` responses. It reproduced all required
function markers:

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

Claude uses its own existing CLI authentication to run, but no credential or
conversation state is shared from the Codex side.

## Observed contract details

- Production requires scoped `rth:sync` to write and `rth:read` to retrieve. The
  proof used an existing production relayhistory session, refreshed through the
  normal refresh endpoint; no token was printed or committed.
- Production `/v1/admin/mint` remains correctly disabled (HTTP 404).
- PR #23 implements the durable transcript as the `conversation_turns` journal in
  the default-tier Neon store, not as a literal JSONL object. The observable HTTP
  round trip proves that the stored transcript is sufficient for cross-harness
  continuation. If "JSONL stored in relayhistory-cloud" is a literal storage
  requirement rather than a wire-format requirement, the implementation still
  needs a JSONL persistence/export contract.

## Re-run

```sh
# RELAYHISTORY_CURL_CONFIG must be a mode-600 curl config containing the
# caller's Authorization header; it is never logged by the script.
RELAYHISTORY_CURL_CONFIG=/secure/path/relayhistory-curl.conf \
  ./scripts/prove-cross-harness-continuity.sh --remote
```

The script defaults to production. `--remote` prevents mock fallback, so a pass
is deployed-cloud evidence.
