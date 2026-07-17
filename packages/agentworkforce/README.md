# agentworkforce

Top-level installer for the Agent Workforce CLI.

```sh
npm i -g agentworkforce
```

Then:

```sh
agentworkforce create [--save-in-directory=<target>] [--save-default] [--install-in-repo] [--no-launch-metadata]
agentworkforce agent [--install-in-repo] [--no-launch-metadata] <persona>[@<tier>]
agentworkforce list [flags]
agentworkforce show <persona>
agentworkforce sources <list|add|remove>
agentworkforce harness check
agentworkforce --version
```

This package is a thin wrapper around [`@agentworkforce/cli`](https://www.npmjs.com/package/@agentworkforce/cli).
It exists so the global install command and the binary name match the
project name.

The wrapper validates that its associated `@agentworkforce/cli` has the same
version before running it. When the current project has a newer local
`agentworkforce` install, the wrapper uses that install only when its wrapper
and associated CLI versions also match. Partial installs fail with a copyable
reinstall command instead of silently executing a stale nested CLI.
An already-running pre-fix wrapper cannot use this selection logic, so users on
4.1.25 must reinstall or update `agentworkforce` before the fix can take effect.
The fixed wrapper does not query a registry for the latest release, so without a
newer coherent local install it cannot detect that its own coherent version is
stale relative to a future release; updating or reinstalling remains required.

See the [main README](https://github.com/AgentWorkforce/workforce#readme)
for the full feature tour, and [`packages/cli/README.md`](https://github.com/AgentWorkforce/workforce/blob/main/packages/cli/README.md)
for command reference.
