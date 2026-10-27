# Workforce runtime

## Harness provider failures

`ctx.harness.run()` rejects with `HarnessProviderError` when a failed model CLI
run reports a recognized usage/credit limit, rate limit, authentication error,
context limit, request timeout, or provider outage. Classification is shared by
all personas; handlers do not need their own output parsers. Successful runs,
unrecognized failures, and OS kill exits retain the `HarnessRunResult` contract.

The error's `message` is safe to display. `providerFailure` contains its `kind`,
message, optional provider, and optional `resetHint` copied only from a valid
clock time with an explicit timezone. Reset hints are provider reports, not
promises of recovery. The original result is retained as the non-enumerable
`error.result` for explicit operator diagnosis; do not post it to users.

The runtime logs `harness.provider_error`, and the runner preserves
`providerFailure` alongside the actionable `error` on `runner.handler.error`.
Cloud can persist that run error and use the structured metadata for customer
notifications without reparsing CLI output. Callers that intentionally handle a
provider failure can catch `HarnessProviderError`; existing generic exit-code
checks no longer replace recognized provider causes.

This boundary does not retry tasks, change credentials, or fall back to another
provider or a paid API key. Those actions need their own explicit policy because
a failed task may already have performed work.
