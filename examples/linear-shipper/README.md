# Linear Shipper

This deployable persona follows the paraglide pattern: a Linear issue triggers a sandboxed implementation run, then the agent links the result back to Linear.

## Setup

Connect Linear and GitHub before deploying.

```bash
workforce deploy ./examples/linear-shipper/persona.json --mode dev
```

Set the target repository through the persona inputs: `GITHUB_OWNER`, `GITHUB_REPO`, and `REPO_URL`.

## Current GitHub Handoff

The v1 client contract exposes `createIssue`, not `createPr`, so the example creates a draft handoff issue and includes a `TODO(human)` where `createPr` should be used once the runtime exposes it.
