# turn-kit multi-turn agent

Minimal runnable Relay channel agent demonstrating
`@agentworkforce/turn-kit`.

The persona explicitly enables workspace memory. The handler derives a stable
conversation id from the Relay channel + thread (or the peer identity for a
direct message), receives chronological history, sends one direct-model reply
to the originating channel or peer, requires a Relay delivery receipt, and only
then saves the turn. Direct messages fail closed when their peer identity is
unavailable, so separate senders cannot share workspace-scoped history.

```bash
agentworkforce deploy ./examples/turn-agent/persona.ts --mode cloud
```

Real agents can add deterministic `defineTurnContext()` providers and interim
`acknowledge()` messages without changing that lifecycle.
