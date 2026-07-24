# turn-kit multi-turn agent

Minimal runnable Relay channel agent demonstrating
`@agentworkforce/turn-kit`.

The persona explicitly enables workspace memory. The handler derives a stable
conversation id from the Relay channel + thread, receives chronological
history, sends one direct-model reply, requires a Relay delivery receipt, and
only then saves the turn.

```bash
agentworkforce deploy ./examples/turn-agent/persona.ts --mode cloud
```

Real agents can add deterministic `defineTurnContext()` providers and interim
`acknowledge()` messages without changing that lifecycle.
