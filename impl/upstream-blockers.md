# Release blockers

The requested branch contains the workforce changes. It is not ready for the
SPEC's production definition-of-done or a ready-to-merge PR.

1. The npm registry queried on 2026-09-12 reports both `@agent-relay/cloud` and
   `@agent-relay/sdk` latest as `12.1.0`. Neither package exports `./fleet` or
   `./attach`. The existing workforce dependency remains `^10.1.0`; there is
   no verified release to bump to. `pnpm install` leaves the lockfile unchanged.
   `sandbox-interactive.ts` has an explicit, lazy SDK dependency boundary so
   local and hosted commands remain loadable; production interactive launch
   throws an actionable error until the upstream exports are published. Its
   local types describe the requested contract; they are not evidence of a
   working published SDK. Replace this boundary with typed direct imports and
   the verified release bump as part of the upstream integration gate.
2. The local Relay checkout's `FleetNodeAttachProxy` actually exposes
   `brokerUrl`, `apiKey`, `requestTimeoutMs`, and `close()`. It does not expose
   `socketPath` or `finished`. A thin re-export alone cannot implement the
   SPEC: Relay must supply an actual terminal-to-UNIX-socket adapter, harness
   execution/exit handling, and the fleet spawn wrapper before publication.
3. The plan assigns Relay SDK implementation, its tests, and the 1630 live
   roundtrip to a separate Relay PR that must merge and publish first. Those
   changes have not been made in this workforce checkout or published.
4. Cloud must accept and enforce `readonlyPaths` with chmod-444 semantics.
   See `packages/persona-repo-router/skills/persona-relayfile-mount.md:66-72`.
   Forwarding the paths in contract tests does not establish live enforcement.
5. The installed `flows check` rejects the supplied `wire-up.flow.ts` as
   invalid YAML/JSON. That is a tool/flow format incompatibility outside this
   checkout. The check was attempted; it did not pass.
6. The full repository test gate is not green: Node 22 fails existing runtime
   version requirements; a supplemental Node 26 run also failed unchanged
   runtime tests and was stopped. See `impl/validation.md`.
7. No live sandbox/read-only roundtrip, cloud service rollout, landing-page
   update, remote CI run, or PR creation is claimed. The surrounding wire-up
   flow assigns PR publication to a separate deterministic shipper step.

Before rollout: publish and verify Relay's exports and request/response types,
bump both workforce consumers and the lockfile, verify real persona terminal
execution and auth modes, pass the opt-in smoke and Relay 1630 live test,
resolve the flow checker format, and obtain green CI.

Implementation clarification: the existing sandbox launcher executes a Node
handler, and `PersonaSpec` explicitly permits such handlers to omit `harness`
or set `sandbox: false` for their internal runtime. Applying interactive
eligibility validation to them would be a regression. A shared pure
`personaToSandboxContext` supplies the same identity/env derivation to those
handlers; interactive launches still reject all three specified invalid shapes.
