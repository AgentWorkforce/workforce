---
name: instrument-dont-guess
description: Use when a fix has failed two consecutive times for the same symptom. Encodes the discipline that the third action must be a temporary diagnostic (a /_diag endpoint, an enriched structured log, a runtime-captured snapshot) rather than another fix attempt. Also covers the discipline for removing those diagnostics once the real root cause is in.
---

# Instrument-don't-guess

When a fix fails twice, the third attempt is not "another fix." It is a **diagnostic** — a temporary endpoint, an enriched log, a runtime-captured snapshot — that turns the next iteration from a guess into a measurement. Guessing past two failed fixes costs more time than the diagnostic does. Battle-scarred from several Nango / Worker / persona-deploy sessions where the third, fourth, fifth fix attempt all missed the real cause that was visible in 30 seconds of structured logging.

## The trigger

After two consecutive fix attempts for the **same symptom** have failed (deploy still 500s on the same call, sync still no-ops, webhook still doesn't fire), stop. The next thing you ship to production is a diagnostic, not a fix.

A "fix attempt" is any code/config change you reasonably believed would resolve the symptom. Two of those, both shipped to where the symptom occurs, both failing to resolve it.

What counts as "same symptom":

- Same error class, same code path, same downstream signal.
- A "different" error that's clearly the next downstream step of the same code path is still the same symptom (e.g. "the 500 is now a 502" is not progress; you just changed where the error surfaces).

## What the diagnostic must do

The diagnostic captures **ground truth about runtime state at the failure point**, structured for easy reading:

- **The actual values of variables the fix logic depends on.** Not "config.foo seemed wrong" — the literal value of `config.foo` at the moment of failure, the type, whether it's `null` vs `undefined` vs `""`.
- **The actual code path taken.** Not "I assume it went through branch A" — log the branch.
- **The actual upstream call results** (when the failure is downstream of an integration call): the HTTP status, the response body excerpt (redacted), the latency, the request headers (redacted).
- **The actual resource bindings at runtime** (when on a serverless platform): does `Resource.X.value` return the expected value at the line of use? `process.env.X`? Both? Neither?

Forms of diagnostic, by environment:

- **HTTP endpoint** (Next.js, Worker): a temporary `/api/_diag/<name>` route that exercises the failing code path and returns the captured state as JSON. Gated by a header or query secret so it isn't open to the world.
- **Enriched structured log** at the failure point: `log.error("diag:<run-name>:<step>", { actualValue, actualType, branchTaken, upstreamStatus, upstreamBodyExcerpt })`.
- **CloudWatch / Workers Logs probe** at deploy boot: confirm the resource bindings landed (this is the canonical cloud-repo `[boot] resource binding check FAILED` pattern).
- **Runtime snapshot file**: in a long-lived process, write the captured state to `/tmp/diag-<name>-<ts>.json` for later read.

## What the diagnostic must NOT do

- Mutate production data.
- Mask the symptom (a try/catch that just logs and returns 200 is anti-diagnostic).
- Carry secrets in cleartext.
- Stay in production after the root cause is in.

## Procedure

1. **Define the question.** Write a one-sentence question the diagnostic will answer. "Is `Resource.NangoSecretKey.value` non-empty at the entry of `/api/v1/sync/refresh` in the Worker runtime?" Not "what's wrong with the sync."
2. **Build the smallest diagnostic that answers the question.** No general-purpose dashboards; one question, one diagnostic. Often <30 lines.
3. **Ship it through CI.** Diagnostics are not "manual prod deploy" exceptions — they go through the same flow as fixes.
4. **Read the diagnostic output.** Read it literally. The most common failure mode at this step is reading what you expected to see rather than what's there. If `Resource.X.value === ""`, the value is the empty string, not "null-ish, probably a parsing issue, probably the secret seeding."
5. **Form the next-fix hypothesis from the diagnostic data, not from intuition.** If the diagnostic says `Resource.X.value === ""`, the next fix is "trace why the SST link did not materialize," not "let me try a different code path."
6. **Ship the next fix.** Verify the diagnostic flips from the failure state to the expected state.
7. **Revert the diagnostic in the same PR or an immediate follow-up.** Diagnostics are temporary scaffolding. Forgetting to revert leaves a `/_diag` endpoint live in production indefinitely (the cloud-repo Phase 3 follow-up tracker has this exact item open).

## When two failed fixes are actually two-of-different-things

Sometimes the two fixes addressed two different real bugs in series — each fix was correct for its layer, the second symptom is genuinely a new symptom. The signal: the symptom **changed in kind**, not just in surface. Different error class, different code path, different downstream signal.

In that case the two-failed-fix counter resets — you're on attempt one of a new symptom. But be honest about whether the symptom actually changed; the common rationalization is to call the same symptom a different one to avoid the diagnostic step.

## Anti-patterns

- **Guess-and-deploy loops.** "Let me try X. ... still failing. Let me try Y. ... still failing. Let me try Z." Three deploys = three slots that could have been one diagnostic + one informed fix.
- **Vague log messages.** `log.error("something failed", err)` — what was `err.message` exactly? What were the inputs? Replace with structured logs that capture the question's answer.
- **Wrapping the symptom in retry.** "It's flaky, let me add a retry" — sometimes correct; usually it's masking a deterministic bug that the diagnostic would reveal.
- **Reading logs and seeing what you expected.** Re-read the diagnostic output, character by character, against the one-sentence question from step 1.
- **Leaving the diagnostic in.** The temporary endpoint stays. The enriched log spams CloudWatch. Both have happened. Revert in the same PR cycle.

## Real-world cases this discipline came out of

- The cloud-repo Nango sync 502: two fix attempts (timeouts, retry, request-handling) all missed that the Worker was using the core non-Hyperdrive db client. A diagnostic endpoint that logged `client.constructor.name` at the failure point would have surfaced this in one cycle.
- The persona-deploy persist-persona-version INSERT failure: the symptom was a 500, the `errorResponse` helper logged only `error.message`. Enriching the log to include `error.code`, `error.detail`, `error.column`, `error.constraint`, `error.routine` would have given the PG cause directly instead of triggering speculation.
- The Resource.NangoSecretKey.value `""` regression: visible in 30 seconds of a boot-time resource probe; was missed for >24h because the failure surfaced as a generic 500 downstream.

## What this skill does NOT cover

- Whether to fix at all vs roll back (covered by `dormant-flip-and-rollback`).
- The auto-merge bar for the fix PR (covered by `auto-merge-and-composition-safety`).
- Cross-PR composition risk for the fix (covered by `auto-merge-and-composition-safety`).
- The contract authority to ship the diagnostic (covered by `autonomous-run-contract`; diagnostics ship under the same merge authority as fixes).
