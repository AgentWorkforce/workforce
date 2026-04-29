# agentworkforce

Top-level installer for the Agent Workforce CLI.

```sh
npm i -g agentworkforce
```

Then:

```sh
agentworkforce agent <persona>[@<tier>]
agentworkforce list [flags]
agentworkforce show <persona>
agentworkforce harness check
```

This package is a thin wrapper around [`@agentworkforce/cli`](https://www.npmjs.com/package/@agentworkforce/cli).
It exists so the global install command and the binary name match the
project name. Functionally identical to installing `@agentworkforce/cli`
and invoking `agent-workforce` — both bins call into the same code path.

See the [main README](https://github.com/AgentWorkforce/workforce#readme)
for the full feature tour, and [`packages/cli/README.md`](https://github.com/AgentWorkforce/workforce/blob/main/packages/cli/README.md)
for command reference.
