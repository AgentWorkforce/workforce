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

### Prepared execution ownership

Both `defineWorkforcePersonaSpawnNode` and `workforcePersonaSpawnCapability`
accept `onExecutionPrepared(name, execution)`. The factory awaits this callback
once per prepared launch, including coalesced requests, before asking the broker
to spawn. `execution.handle` is the actual `ExecutionHandle` returned by the
persona executor; `execution.scratchDir` is its factory-owned parent directory.
Hosts can retain this receipt and persist ownership before delegation begins.

If the callback throws or rejects, no spawn is requested. If preparation or
broker delegation fails, the factory disposes its prepared resources and removes
the scratch directory; discard any retained receipt for that failed launch.

After a successful spawn, the host owns the remaining lifetime. Release the
specific launched worker through the broker and verify that it has stopped before
calling `await execution.handle.dispose()`, then remove `execution.scratchDir`.
Disposal stops mount synchronization and restores generated files. Do not dispose
inside the preparation callback or while delegation is pending. The callback is
optional; omitting it preserves the existing successful-execution lifetime.
