# Implementation Instructions

IMPLEMENTATION_WORKFLOW_CONTRACT:

- For implementation specs, edit source files and produce code changes, not just plan.md, mapping.json, or analysis artifacts.
- Keep a non-empty implementation diff outside transient artifact directories.
- Add or update tests that prove the changed behavior.
- Keep execution routing explicit for local, cloud, and MCP callers.
- Materialize outputs to disk, then stop for deterministic gates.
