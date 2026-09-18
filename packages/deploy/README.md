# @agentworkforce/deploy

Deploy event-driven personas with `deploy({ personaPath, mode })`. Modes are
`local`, `sandbox`, and `cloud`. `localLauncher` runs the bundle on the local
machine. `devLauncher`, `mode: 'dev'`, and `resolvers.modes.dev` remain deprecated
aliases for one minor release; `deploy()` warns when legacy options are used.

`launchInteractiveSandbox({ persona, workspace, stdio, inputs?, authMode?,
provider?, sandboxId?, attachMode?, task? })` composes Relay's fleet and attach
SDK primitives. `authMode` defaults to `managed`, and `attachMode` to `drive`.
`attached` resolves after the UNIX socket connects. `finished` carries the
harness exit code. `detach()` closes the local connection while leaving the
sandbox running; idempotent `stop()` also deletes the sandbox. Stdio streams
belong to the caller and stdout is never ended by the launcher.

The persona mapper in `@agentworkforce/persona-kit` converts explicit subtree
allow-lists into Relayfile paths, copies read-only paths, and rejects personas
without a supported harness or with `sandbox: false`. Unscoped mounts omit
`relayfilePaths` from the SDK request because ensure rejects an empty array.

Release dependency: published `@agent-relay/cloud@12.1.0` does not yet export
`/fleet` or `/attach`. This implementation loads those SDK exports on demand
and fails explicitly until the upstream contract ships. No CLI fallback is
provided. Before enabling production use, bump and verify the published SDK,
run the opt-in live smoke, and verify Cloud materializes read-only files with
chmod-444 semantics (see `persona-repo-router/skills/persona-relayfile-mount.md`).
The read-only payload alone does not prove enforcement.
