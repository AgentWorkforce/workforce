# @agentworkforce/local-surface

Compose AgentWorkforce personas into Agent Relay fleet nodes without starting
the `agentworkforce` CLI.

## Interactive persona spawning

`defineWorkforcePersonaSpawnNode` advertises `spawn:persona`. The target node
resolves persona ids and JSON paths through the same project, personal,
configured-directory, and built-in registry as `agentworkforce agent`.

```ts
import { serveNode } from '@agent-relay/fleet';
import { defineWorkforcePersonaSpawnNode } from '@agentworkforce/local-surface';

const definition = defineWorkforcePersonaSpawnNode({
  nodeName: 'workforce-personas',
  cwd: process.cwd()
});

await serveNode({ definition, connection });
```

The capability prepares the persona in process with `persona-kit`, including
its skills, MCP servers, sidecars, harness, model, and harness settings. A
request `task` is delivered separately as the concrete assignment. Concurrent
requests for the same node, project, persona, and agent name share one launch, and the
Relay broker verifies node registration plus the harness `worker_ready`
handshake before the action succeeds. This path requires Agent Relay 11.5 or
newer. The isolated mount auto-syncs agent changes back to the project and
flushes once more during teardown.

## Proactive event persona

`defineWorkforcePersonaNode` remains the long-lived channel `onMessage` surface.
It composes `@agentworkforce/deploy` for a persona that consumes Relay message
events rather than launching an interactive worker per request.
