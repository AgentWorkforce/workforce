# Changelog

All notable changes to `@agentworkforce/turn-kit` will be documented in this
file.

## [Unreleased]

### Added

- Add a transport-neutral turn runner with chronological conversation memory,
  deterministic context providers, best-effort interim acknowledgements,
  delivery confirmation, and post-delivery persistence.
- Add standalone conversation identity, recall, and persistence helpers for
  handlers that need only part of the lifecycle.
- Add a pass-through persona factory that requires durable memory and expose
  the bundled kit version in runtime logs.
- Add a provider-agnostic confirmed-action helper that constructs success
  output only after the caller's receipt predicate passes.
- Add the optional `@agentworkforce/turn-kit/assistant` bridge so Workforce
  history and deterministic context blocks can use
  `@agent-assistant/turn-context` for canonical identity/context assembly and
  harness projection.
- Align deterministic context blocks with the Agent Assistant prepared-context
  shape (`id`, `label`, `content`, source/category metadata).
