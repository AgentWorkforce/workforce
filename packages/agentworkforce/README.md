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

See the [main README](https://github.com/AgentWorkforce/workforce#readme)
for the full feature tour, and [`packages/cli/README.md`](https://github.com/AgentWorkforce/workforce/blob/main/packages/cli/README.md)
for command reference.
