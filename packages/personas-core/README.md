# @agentworkforce/personas-core

Core first-party AgentWorkforce persona pack.

This package contains generic, reusable personas owned by the AgentWorkforce
repo. It is an npm-distributed persona pack: `agentworkforce install` reads the
package metadata below and copies JSON files from `personas/` into the current
project.

```json
{
  "agentworkforce": {
    "personas": "personas"
  }
}
```

`persona-maker` is not part of this pack. It remains available from the
internal built-in distribution, so `agentworkforce create` does not require
installing `@agentworkforce/personas-core`.

## Install All

Install every persona into the current project:

```sh
agentworkforce install @agentworkforce/personas-core
```

From a checkout of this repo, install the local package directly:

```sh
agentworkforce install ./packages/personas-core
```

The command copies files into:

```text
./.agentworkforce/workforce/personas/
```

Installed files are project-owned. Commit and edit them like any other local
persona JSON.

## Install One Persona

Use `--persona <id>` to copy only selected personas:

```sh
agentworkforce install @agentworkforce/personas-core --persona code-reviewer
agentworkforce install @agentworkforce/personas-core --persona frontend-implementer --persona verifier
```

## Version Pinning

Persona packs use normal npm package resolution. Pin a specific package
version for reproducible installs:

```sh
agentworkforce install @agentworkforce/personas-core@0.8.0
```

You can also use npm tags when that is appropriate for your workflow:

```sh
agentworkforce install @agentworkforce/personas-core@latest
```

## Personas

| Persona | Intent | Description |
| --- | --- | --- |
| `architecture-planner` | `architecture-plan` | Produces architecture plans, tradeoffs, and migration paths. |
| `capability-discoverer` | `capability-discovery` | Finds existing skills, agents, and hooks for a project by searching both the skills.sh ecosystem and prpm.dev instead of hand-rolling new logic. Picks the best fit across providers and emits the exact install command. |
| `code-reviewer` | `review` | Reviews pull requests for correctness, risk, and maintainability. |
| `debugger` | `debugging` | Drives root-cause debugging for failing builds, regressions, and runtime defects with minimal corrective changes. |
| `e2e-validator` | `e2e-validation` | Owns end-to-end validation of features by driving real or high-fidelity stacks and proving the golden path with fresh evidence. |
| `flake-hunter` | `flake-investigation` | Diagnoses intermittent test failures and removes root-cause nondeterminism instead of masking it. |
| `frontend-implementer` | `implement-frontend` | Implements frontend UI features with strong UX and maintainable code. |
| `integration-test-author` | `write-integration-tests` | Writes integration tests that exercise real adapters, real serialization, and real error envelopes against in-memory or local substitutes - not unit-level mocks. |
| `requirements-analyst` | `requirements-analysis` | Turns rough feature ideas into explicit acceptance criteria, edge cases, and open questions before planning or coding begins. |
| `security-reviewer` | `security-review` | Reviews code and plans for exploitable security risks, unsafe defaults, and missing defensive controls. |
| `tdd-guard` | `tdd-enforcement` | Enforces red-green-refactor discipline so teams prove behavior before implementation. |
| `technical-writer` | `documentation` | Produces accurate developer-facing documentation, READMEs, API notes, and change guidance grounded in the actual code. |
| `test-strategist` | `test-strategy` | Designs pragmatic test plans, risk-ranked coverage, and the smallest test set that buys confidence. |
| `verifier` | `verification` | Checks whether completion claims are actually supported by fresh evidence, acceptance criteria coverage, and relevant tests. |

## Validate

```sh
corepack pnpm --filter @agentworkforce/personas-core run lint
```
